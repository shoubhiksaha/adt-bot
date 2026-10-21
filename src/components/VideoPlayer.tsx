import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { loadMedia } from "../lib/video";

/** A video kept on this device, played in the chat (with a save button). */
export function VideoPlayer({ mediaId, name }: { mediaId: string; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let made: string | null = null;
    void loadMedia(mediaId).then((blob) => {
      if (!blob) return setMissing(true);
      made = URL.createObjectURL(blob);
      setUrl(made);
    });
    return () => {
      if (made) URL.revokeObjectURL(made);
    };
  }, [mediaId]);
  if (missing) return <div className="small muted">This video is on the device it was made on.</div>;
  if (!url) return <div className="video-player loading" />;
  return (
    <div className="video-player">
      <video src={url} controls playsInline preload="metadata" />
      <a className="btn" href={url} download={name}>
        <Download size={14} /> Save video
      </a>
    </div>
  );
}
