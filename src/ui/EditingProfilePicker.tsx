import { useRef } from "react";
import { EDITORIAL_PROFILES } from "../application/editorialProfiles";
import { resolveAestheticSystem } from "../application/editkinAesthetic";
import type { EditorialProfileId } from "../domain/types";
import "./editingProfilePicker.css";

interface EditingProfilePickerProps {
  profile: EditorialProfileId;
  hasVideo: boolean;
  trackingBusy: boolean;
  onChange: (profile: EditorialProfileId) => void;
  onStartSpeakerDirector: () => void;
}

export function EditingProfilePicker({ profile, hasVideo, trackingBusy, onChange, onStartSpeakerDirector }: EditingProfilePickerProps) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  const selected = EDITORIAL_PROFILES.find((item) => item.id === profile) ?? EDITORIAL_PROFILES[0];
  const aesthetic = resolveAestheticSystem(selected.id, "shorts");
  const icons: Record<EditorialProfileId, string> = { auto: "✦", gaming: "◈", food: "●", travel: "⌁", podcast_on_camera: "◉", podcast_no_face: "♫" };
  return (
    <details ref={disclosure} className="editing-profile-picker" aria-label="剪輯類型" data-testid="editing-profile-picker">
      <summary>
        <span className="profile-heading"><b aria-hidden="true">{icons[selected.id]}</b><span><strong>影片類型：{selected.shortLabel}</strong><small>{aesthetic.primaryLabel}</small></span></span>
        <span className="profile-change-hint">切換</span>
      </summary>
      <div className="profile-disclosure-body">
        <p>{selected.description}</p>
        <div className="profile-options" role="radiogroup" aria-label="影片類型">
          {EDITORIAL_PROFILES.map((item) => <button type="button" role="radio" aria-checked={profile === item.id} className={profile === item.id ? "active" : ""} onClick={() => { onChange(item.id); if (disclosure.current) disclosure.current.open = false; }} key={item.id}><b aria-hidden="true">{icons[item.id]}</b><span>{item.shortLabel}</span></button>)}
        </div>
        {profile === "podcast_on_camera" && <button className="speaker-director-button" type="button" disabled={!hasVideo || trackingBusy} onClick={onStartSpeakerDirector}>
          {trackingBusy ? "分析中…" : "框兩位人物"}
        </button>}
      </div>
    </details>
  );
}
