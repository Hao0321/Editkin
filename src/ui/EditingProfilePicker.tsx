import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
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
  unavailableReason?: string;
}

export function EditingProfilePicker({ profile, hasVideo, trackingBusy, onChange, onStartSpeakerDirector, unavailableReason }: EditingProfilePickerProps) {
  useI18n();
  const disclosure = useRef<HTMLDetailsElement>(null);
  const selected = EDITORIAL_PROFILES.find((item) => item.id === profile) ?? EDITORIAL_PROFILES[0];
  const aesthetic = resolveAestheticSystem(selected.id, "shorts");
  const icons: Record<EditorialProfileId, string> = { auto: "✦", gaming: "◈", food: "●", travel: "⌁", music_mv: "♫", podcast_on_camera: "◉", podcast_no_face: "◇" };
  return (
    <details ref={disclosure} className="editing-profile-picker" aria-label={uiText("剪輯類型")} data-testid="editing-profile-picker">
      <summary>
        <span className="profile-heading"><b aria-hidden="true">{icons[selected.id]}</b><span><strong>{uiText("影片類型：")}{uiText(selected.shortLabel)}</strong><small>{uiText(aesthetic.primaryLabel)}</small></span></span>
        <span className="profile-change-hint">{uiText("切換")}</span>
      </summary>
      <div className="profile-disclosure-body">
        <p>{uiText(selected.description)}</p>
        <div className="profile-options" role="group" aria-label={uiText("影片類型")}>
          {EDITORIAL_PROFILES.map((item) => <button type="button" aria-pressed={profile === item.id} className={profile === item.id ? "active" : ""} onClick={() => { onChange(item.id); if (disclosure.current) disclosure.current.open = false; }} key={item.id}><b aria-hidden="true">{icons[item.id]}</b><span>{uiText(item.shortLabel)}</span></button>)}
        </div>
        {profile === "podcast_on_camera" && <button className="speaker-director-button" type="button" disabled={!hasVideo || trackingBusy || Boolean(unavailableReason)} title={unavailableReason} onClick={onStartSpeakerDirector}>
          {trackingBusy ? uiText("分析中…") : uiText("框兩位人物")}
        </button>}
      </div>
    </details>
  );
}
