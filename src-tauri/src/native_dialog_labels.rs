//! Native dialog presentation; never project text, filenames or authority decisions.

#[derive(Clone, Copy, Debug)]
pub enum DialogText {
    MediaTitle,
    MediaFilter,
    BatchTitle,
    VideoFilter,
    BatchFolder,
    OpenProject,
    SaveProject,
    ProjectFilter,
    ExportVideo,
    Mp4Filter,
    ExportAlpha,
    ExrFolder,
    UpdateTitle,
    UpdatePrompt,
    AgentFolder,
    RelinkMedia,
}

fn locale_index(locale: Option<&str>) -> usize {
    match locale {
        Some("en") => 1,
        Some("es") => 2,
        Some("ja") => 3,
        Some("ko") => 4,
        _ => 0,
    }
}

pub fn text(locale: Option<&str>, message: DialogText) -> &'static str {
    let labels = match message {
        DialogText::MediaTitle => ["匯入影片、聲音或圖片", "Add videos, audio, or images", "Añadir vídeos, audio o imágenes", "動画・音声・画像を追加", "동영상, 오디오 또는 이미지 추가"],
        DialogText::MediaFilter => ["媒體素材", "Media files", "Archivos multimedia", "メディアファイル", "미디어 파일"],
        DialogText::BatchTitle => ["選取要批量自動剪輯的新影片", "Choose videos to edit automatically", "Elegir vídeos para la edición automática", "自動編集する動画を選択", "자동으로 편집할 동영상 선택"],
        DialogText::VideoFilter => ["影片素材", "Video files", "Archivos de vídeo", "動画ファイル", "동영상 파일"],
        DialogText::BatchFolder => ["選擇批量成片與可編輯專案的儲存資料夾", "Choose a folder for edited videos and projects", "Elegir carpeta para vídeos editados y proyectos", "編集した動画とプロジェクトの保存先を選択", "편집한 동영상과 프로젝트를 저장할 폴더 선택"],
        DialogText::OpenProject => ["開啟 Editkin 專案", "Open an Editkin project", "Abrir un proyecto de Editkin", "Editkin プロジェクトを開く", "Editkin 프로젝트 열기"],
        DialogText::SaveProject => ["儲存 Editkin 專案", "Save the Editkin project", "Guardar el proyecto de Editkin", "Editkin プロジェクトを保存", "Editkin 프로젝트 저장"],
        DialogText::ProjectFilter => ["Editkin 專案", "Editkin projects", "Proyectos de Editkin", "Editkin プロジェクト", "Editkin 프로젝트"],
        DialogText::ExportVideo => ["輸出完成影片", "Export the finished video", "Exportar el vídeo terminado", "完成した動画を書き出す", "완성된 동영상 내보내기"],
        DialogText::Mp4Filter => ["MP4 影片", "MP4 video", "Vídeo MP4", "MP4 動画", "MP4 동영상"],
        DialogText::ExportAlpha => ["輸出透明背景 ProRes 4444 Alpha 主檔", "Export ProRes 4444 with transparency", "Exportar ProRes 4444 con transparencia", "透明背景の ProRes 4444 を書き出す", "투명 배경의 ProRes 4444 내보내기"],
        DialogText::ExrFolder => ["選擇 OpenEXR 影格序列的上層資料夾（不含音訊）", "Choose a folder for OpenEXR frames (no audio)", "Elegir carpeta para fotogramas OpenEXR (sin audio)", "OpenEXR フレームの保存先を選択（音声なし）", "OpenEXR 프레임을 저장할 폴더 선택 (오디오 없음)"],
        DialogText::UpdateTitle => ["安裝更新", "Install update", "Instalar actualización", "更新をインストール", "업데이트 설치"],
        DialogText::UpdatePrompt => ["安裝版本 {version}？\n專案檔不會被移動。", "Install version {version}?\nYour project files will stay in place.", "¿Instalar la versión {version}?\nLos archivos del proyecto permanecerán en su ubicación.", "バージョン {version} をインストールしますか？\nプロジェクトファイルは移動しません。", "버전 {version}을 설치할까요?\n프로젝트 파일은 이동하지 않습니다."],
        DialogText::AgentFolder => ["選擇要授權給 AI 的工作資料夾（專案與素材需在此範圍內）", "Authorize AI folder (projects and media stay inside)", "Carpeta para IA (proyectos y archivos dentro)", "AI に許可するフォルダー（プロジェクトと素材の範囲）", "AI에 허용할 폴더 선택 (프로젝트와 미디어 범위)"],
        DialogText::RelinkMedia => ["找回原本的素材檔案", "Find the original media file", "Buscar el archivo multimedia original", "元の素材ファイルを探す", "원래 미디어 파일 찾기"],
    };
    labels[locale_index(locale)]
}

pub fn update_confirmation(locale: Option<&str>, version: &str) -> String {
    text(locale, DialogText::UpdatePrompt).replace("{version}", version)
}

#[cfg(test)]
mod tests {
    use super::*;
    const ALL: [DialogText; 16] = [
        DialogText::MediaTitle,
        DialogText::MediaFilter,
        DialogText::BatchTitle,
        DialogText::VideoFilter,
        DialogText::BatchFolder,
        DialogText::OpenProject,
        DialogText::SaveProject,
        DialogText::ProjectFilter,
        DialogText::ExportVideo,
        DialogText::Mp4Filter,
        DialogText::ExportAlpha,
        DialogText::ExrFolder,
        DialogText::UpdateTitle,
        DialogText::UpdatePrompt,
        DialogText::AgentFolder,
        DialogText::RelinkMedia,
    ];

    #[test]
    fn every_locale_covers_all_native_dialog_messages() {
        for locale in ["zh-TW", "en", "es", "ja", "ko"] {
            for key in ALL {
                assert!(!text(Some(locale), key).is_empty());
            }
        }
    }

    #[test]
    fn languages_select_distinct_real_labels() {
        let labels = ["zh-TW", "en", "es", "ja", "ko"]
            .map(|locale| text(Some(locale), DialogText::MediaTitle));
        assert_eq!(
            labels,
            [
                "匯入影片、聲音或圖片",
                "Add videos, audio, or images",
                "Añadir vídeos, audio o imágenes",
                "動画・音声・画像を追加",
                "동영상, 오디오 또는 이미지 추가"
            ]
        );
    }

    #[test]
    fn missing_and_invalid_locale_keep_legacy_traditional_chinese() {
        for locale in [
            None,
            Some(""),
            Some("en-US"),
            Some("<script>"),
            Some("unknown"),
        ] {
            for key in ALL {
                assert_eq!(text(locale, key), text(Some("zh-TW"), key));
            }
        }
    }

    #[test]
    fn update_prompt_preserves_exact_version_and_legacy_chinese() {
        assert_eq!(
            update_confirmation(None, "0.15.1"),
            "安裝版本 0.15.1？\n專案檔不會被移動。"
        );
        for locale in ["zh-TW", "en", "es", "ja", "ko"] {
            let prompt = update_confirmation(Some(locale), "0.15.1-beta.2");
            assert_eq!(prompt.matches("0.15.1-beta.2").count(), 1);
            assert!(!prompt.contains("{version}"));
        }
    }

    #[test]
    fn titles_are_short_and_filters_preserve_format_names() {
        for locale in ["zh-TW", "en", "es", "ja", "ko"] {
            for key in [
                DialogText::MediaTitle,
                DialogText::BatchTitle,
                DialogText::BatchFolder,
                DialogText::OpenProject,
                DialogText::SaveProject,
                DialogText::ExportVideo,
                DialogText::ExportAlpha,
                DialogText::ExrFolder,
                DialogText::UpdateTitle,
                DialogText::AgentFolder,
                DialogText::RelinkMedia,
            ] {
                assert!(text(Some(locale), key).chars().count() <= 64);
            }
            assert!(text(Some(locale), DialogText::ProjectFilter).contains("Editkin"));
            assert!(text(Some(locale), DialogText::Mp4Filter).contains("MP4"));
        }
    }
}
