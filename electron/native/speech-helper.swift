// Renders the Mac's built-in voices to audio for ADT Bot (electron/features/20-speech.cjs), so the
// app plays them itself and the microphone's echo canceller can remove them. Stays running: a warm
// synthesizer renders a sentence in about 0.1 s, where starting `say` each time takes a second.
//
// Protocol: one JSON object per line on stdin, one answer per line on stdout.
//   {"id":1,"text":"Hello.","voice":"Samantha","lang":"en-US","rate":1}
//   -> {"id":1,"wav":"<base64 16-bit mono WAV>"} or {"id":1,"error":"..."}
// Exits when stdin closes and the last answer is out.
import AVFoundation
import Foundation

struct Job {
  let id: Int
  let text: String
  let voice: String?
  let lang: String?
  let rate: Double
}

let synthesizer = AVSpeechSynthesizer()
var queue: [Job] = []
var busy = false
/** stdin closed: finish what was asked, then exit. */
var closing = false

func reply(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object), var line = String(data: data, encoding: .utf8) else { return }
  line += "\n"
  FileHandle.standardOutput.write(line.data(using: .utf8)!)
}

/** The voice speechSynthesis.getVoices() named: same name and language, then same name. */
func findVoice(_ name: String?, _ lang: String?) -> AVSpeechSynthesisVoice? {
  let voices = AVSpeechSynthesisVoice.speechVoices()
  let wanted = (lang ?? "").replacingOccurrences(of: "_", with: "-").lowercased()
  let base = wanted.split(separator: "-").first.map(String.init) ?? ""
  if let name = name, !name.isEmpty {
    let named = voices.filter { $0.name == name || $0.identifier == name }
    return named.first { $0.language.lowercased() == wanted }
      ?? named.first { $0.language.lowercased().hasPrefix(base + "-") }
      ?? (named.count == 1 ? named.first : nil)
  }
  return wanted.isEmpty ? AVSpeechSynthesisVoice(language: nil) : AVSpeechSynthesisVoice(language: wanted)
}

func wav(_ samples: [Int16], rate: Int) -> Data {
  var data = Data()
  func put<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
  let bytes = samples.count * 2
  data.append("RIFF".data(using: .ascii)!)
  put(UInt32(36 + bytes))
  data.append("WAVEfmt ".data(using: .ascii)!)
  put(UInt32(16)); put(UInt16(1)); put(UInt16(1)); put(UInt32(rate)); put(UInt32(rate * 2)); put(UInt16(2)); put(UInt16(16))
  data.append("data".data(using: .ascii)!)
  put(UInt32(bytes))
  // Both Mac architectures are little-endian, like WAV.
  samples.withUnsafeBufferPointer { data.append(Data(buffer: $0)) }
  return data
}

func runNext() {
  if closing && !busy && queue.isEmpty { exit(0) }
  guard !busy, !queue.isEmpty else { return }
  let job = queue.removeFirst()
  guard let voice = findVoice(job.voice, job.lang) else {
    reply(["id": job.id, "error": "The voice \"\(job.voice ?? "")\" isn't installed"])
    return runNext()
  }
  busy = true
  let utterance = AVSpeechUtterance(string: job.text)
  utterance.voice = voice
  utterance.rate = Float(min(Double(AVSpeechUtteranceMaximumSpeechRate), max(Double(AVSpeechUtteranceMinimumSpeechRate), Double(AVSpeechUtteranceDefaultSpeechRate) * job.rate)))
  var samples: [Int16] = []
  var sampleRate = 22050
  var finished = false
  let finish = { (error: String?) in
    if finished { return }
    finished = true
    if let error = error {
      reply(["id": job.id, "error": error])
    } else if samples.isEmpty {
      reply(["id": job.id, "error": "The voice made no sound"])
    } else {
      reply(["id": job.id, "wav": wav(samples, rate: sampleRate).base64EncodedString()])
    }
    busy = false
    DispatchQueue.main.async { runNext() }
  }
  // An utterance that never reports its end (a voice that failed to load) must not block the rest.
  let deadline = DispatchWorkItem { finish("The voice took too long") }
  DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: deadline)
  synthesizer.write(utterance) { buffer in
    DispatchQueue.main.async {
      guard !finished, let pcm = buffer as? AVAudioPCMBuffer else { return }
      // An empty buffer marks the end.
      if pcm.frameLength == 0 {
        deadline.cancel()
        return finish(nil)
      }
      sampleRate = Int(pcm.format.sampleRate)
      let count = Int(pcm.frameLength)
      if let floats = pcm.floatChannelData?[0] {
        for i in 0..<count { samples.append(Int16(max(-1, min(1, floats[i])) * 32767)) }
      } else if let ints = pcm.int16ChannelData?[0] {
        samples.append(contentsOf: UnsafeBufferPointer(start: ints, count: count))
      } else if let ints = pcm.int32ChannelData?[0] {
        for i in 0..<count { samples.append(Int16(truncatingIfNeeded: ints[i] >> 16)) }
      }
    }
  }
}

Thread {
  while let line = readLine() {
    guard let data = line.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let id = object["id"] as? Int else { continue }
    let text = (object["text"] as? String) ?? ""
    DispatchQueue.main.async {
      if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return reply(["id": id, "error": "Nothing to say"])
      }
      queue.append(Job(id: id, text: text, voice: object["voice"] as? String, lang: object["lang"] as? String, rate: (object["rate"] as? Double) ?? 1))
      runNext()
    }
  }
  DispatchQueue.main.async {
    closing = true
    runNext()
  }
}.start()

RunLoop.main.run()
