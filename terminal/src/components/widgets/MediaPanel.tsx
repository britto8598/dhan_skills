"use client";
import { useRef, useState } from "react";
import { useWorkspace } from "@/lib/state/workspace";
import { Btn, Seg, TextInput, cx } from "../ui";
import type { WidgetProps } from "./ChartWidget";
import { youtubeId } from "@/lib/media";

type Aspect = "16:9" | "4:3" | "21:9" | "fill";

/**
 * YouTube / web stream panel: live streams, tutorials or audio news while
 * trading. Float it (⇱ in the header) for picture-in-picture over the charts.
 */
export default function MediaPanel({ id, settings }: WidgetProps) {
  const updateSettings = useWorkspace((s) => s.updateSettings);
  const setFloat = useWorkspace((s) => s.setFloat);
  const isFloat = useWorkspace((s) => !!s.ws.widgets[id]?.float);
  const url = (settings.url as string) ?? "";
  const aspect = ((settings.aspect as Aspect) ?? "16:9") as Aspect;
  const volume = Number(settings.volume ?? 50);
  const muted = settings.muted !== false;
  const audioOnly = !!settings.audioOnly;
  const [draft, setDraft] = useState(url);
  const frame = useRef<HTMLIFrameElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const yt = youtubeId(url);
  const isAudio = !yt && /\.(mp3|aac|m4a|ogg|opus|wav)(\?|$)/i.test(url);
  const set = (p: Record<string, unknown>) => updateSettings(id, p);

  const cmd = (func: string, args: unknown[] = []) => {
    frame.current?.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), "*");
  };
  const play = () => (yt ? cmd("playVideo") : audio.current?.play());
  const pause = () => (yt ? cmd("pauseVideo") : audio.current?.pause());
  const setVol = (v: number) => {
    set({ volume: v });
    if (yt) cmd("setVolume", [v]);
    if (audio.current) audio.current.volume = v / 100;
  };
  const toggleMute = () => {
    set({ muted: !muted });
    if (yt) cmd(muted ? "unMute" : "mute");
    if (audio.current) audio.current.muted = !muted;
  };

  const src = yt ? `https://www.youtube-nocookie.com/embed/${yt}?enablejsapi=1&autoplay=1&mute=${muted ? 1 : 0}&playsinline=1&rel=0&modestbranding=1` : url;
  const ratio = aspect === "16:9" ? 16 / 9 : aspect === "4:3" ? 4 / 3 : aspect === "21:9" ? 21 / 9 : 0;

  return (
    <div className="flex h-full flex-col text-[11px]">
      <form
        className="flex h-[26px] shrink-0 items-center gap-1 border-b border-line px-1"
        onSubmit={(e) => {
          e.preventDefault();
          set({ url: draft.trim() });
        }}
      >
        <TextInput value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="YouTube URL / video ID / live link, or an audio stream URL" className="h-[20px] min-w-0 flex-1 text-[11px]" />
        <Btn active onClick={() => set({ url: draft.trim() })}>
          Load
        </Btn>
      </form>
      <div className="flex h-[24px] shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-1">
        <Btn onClick={play} disabled={!url} title="Play">
          ▶
        </Btn>
        <Btn onClick={pause} disabled={!url} title="Pause">
          ❚❚
        </Btn>
        <Btn onClick={toggleMute} disabled={!url} title={muted ? "Unmute" : "Mute"}>
          {muted ? "🔇" : "🔊"}
        </Btn>
        <input type="range" min={0} max={100} value={volume} onChange={(e) => setVol(Number(e.target.value))} className="w-20 accent-accent" title="Volume" />
        <Seg<Aspect> value={aspect} onChange={(a) => set({ aspect: a })} options={(["16:9", "4:3", "21:9", "fill"] as Aspect[]).map((a) => ({ value: a, label: a === "fill" ? "Fill" : a }))} />
        <Btn active={audioOnly} onClick={() => set({ audioOnly: !audioOnly })} title="Hide video, keep audio playing">
          ♪ Audio only
        </Btn>
        <Btn active={isFloat} onClick={() => setFloat(id, isFloat ? null : { x: window.innerWidth - 500, y: window.innerHeight - 330, w: 460, h: 300 })} title="Picture-in-picture over the workspace">
          PiP
        </Btn>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
        {!url && <div className="p-4 text-center text-muted">Paste a YouTube live stream, tutorial link or audio news URL above.</div>}
        {url && isAudio && <audio ref={audio} src={url} controls autoPlay muted={muted} className="w-[90%]" />}
        {url && !isAudio && (
          <div className={cx("relative", audioOnly ? "h-px w-px overflow-hidden opacity-0" : "")} style={audioOnly ? undefined : ratio ? { aspectRatio: String(ratio), maxWidth: "100%", maxHeight: "100%", width: "100%" } : { width: "100%", height: "100%" }}>
            <iframe
              ref={frame}
              key={src}
              src={src}
              title="Media stream"
              className="absolute inset-0 h-full w-full"
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
              onLoad={() => {
                if (yt) setTimeout(() => cmd("setVolume", [volume]), 800);
              }}
            />
          </div>
        )}
        {url && audioOnly && !isAudio && <div className="absolute text-muted">♪ Audio only — video hidden</div>}
      </div>
    </div>
  );
}
