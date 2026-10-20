import type { Attachment } from "./types";

const MAX_SIDE = 1568;
/** Roughly 50k tokens of text per file: plenty for documents, safe for small local context windows. */
const MAX_FILE_CHARS = 200_000;

const TEXT_EXTENSIONS =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|ya?ml|toml|ini|cfg|conf|env|log|html?|css|scss|less|js|jsx|mjs|cjs|ts|tsx|py|rb|php|java|kt|swift|go|rs|c|h|cc|cpp|hpp|cs|m|sh|bash|zsh|ps1|bat|sql|r|lua|pl|dart|scala|vue|svelte|tex|rst|srt|vtt|ipynb|gradle|dockerfile|makefile)$/i;

export const ACCEPTED_FILES = "image/*,.pdf,.docx,.htm,.html,text/*,.md,.csv,.json,.xml,.yaml,.yml,.toml,.log,.py,.js,.ts,.tsx,.jsx,.java,.go,.rs,.c,.cpp,.h,.cs,.rb,.php,.swift,.kt,.sql,.sh,.html,.css,.ipynb";

/** Turns a picked/pasted/dropped file into an attachment: images are resized, documents become text. */
export async function fileToAttachment(file: File): Promise<Attachment> {
  if (file.type.startsWith("image/")) {
    if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is too large (${Math.round(file.size / 1e6)} MB; up to ${MAX_FILE_BYTES / 1e6} MB).`);
    return imageToAttachment(file);
  }
  return textAttachment(file, await fileText(file));
}

/** The largest file read: past this, a document or image could exhaust the page's memory. */
const MAX_FILE_BYTES = 60_000_000;

/** Readable text from a document: PDF, Word, HTML, Markdown, code, CSV, JSON… */
export async function fileText(file: File): Promise<string> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is too large (${Math.round(file.size / 1e6)} MB; up to ${MAX_FILE_BYTES / 1e6} MB).`);
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return pdfText(file);
  if (/\.docx$/i.test(file.name) || file.type.includes("officedocument.wordprocessingml")) return docxText(file);
  if (/\.html?$/i.test(file.name) || file.type === "text/html") {
    const { extractText } = await import("./search");
    return extractText(await file.text());
  }
  if (file.type.startsWith("text/") || file.type.includes("json") || file.type.includes("xml") || TEXT_EXTENSIONS.test(file.name)) {
    return file.text();
  }
  throw new Error(`${file.name}: only images, PDFs, Word documents and text/code files can be read.`);
}

async function docxText(file: File): Promise<string> {
  const mammoth = await import("mammoth/mammoth.browser.js");
  const { value } = await (mammoth.default ?? mammoth).extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return value;
}

function textAttachment(file: File, raw: string): Attachment {
  const text = raw.replace(/\u0000/g, "");
  if (!text.trim()) throw new Error(`${file.name}: no readable text found (scanned PDFs need OCR first).`);
  return {
    kind: "file",
    name: file.name || "file.txt",
    size: file.size,
    text: text.slice(0, MAX_FILE_CHARS),
    truncated: text.length > MAX_FILE_CHARS || undefined,
  };
}

async function imageToAttachment(file: File): Promise<Attachment> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const keepPng = file.type === "image/png" && file.size < 1_500_000;
  const dataUrl = canvas.toDataURL(keepPng ? "image/png" : "image/jpeg", 0.86);
  return { kind: "image", dataUrl, name: file.name || "image" };
}

/** PDF text via pdf.js, loaded only when a PDF is attached. */
async function pdfText(file: File): Promise<string> {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const pdf = await task.promise;
  const pages: string[] = [];
  let length = 0;
  for (let n = 1; n <= pdf.numPages && length < MAX_FILE_CHARS; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    const text = content.items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : "")).join("");
    pages.push(`--- Page ${n} ---\n${text.trim()}`);
    length += text.length;
  }
  await task.destroy();
  return pages.join("\n\n");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
