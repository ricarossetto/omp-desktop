import { useEffect, useState } from "react";
import { invoke } from "../../api";
import { Icon } from "../../components/Icon";
import { formatBytes } from "../../format";
import { useI18n, useT } from "../../i18n";
import { useActions, useStore } from "../../store/context";
import { errorText } from "../agents/ui-utils";
import { normalizeFileRead, type FileReadView } from "../changes/git-display";
import "./file-preview.css";

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|ico)$/i;

interface ImageView {
	mimeType: string;
	data: string;
	size?: number;
}

/** Preview embutido de texto/imagem; "Abrir externamente" mantém o fluxo antigo. */
export function FilePreview() {
	const t = useT();
	const { locale } = useI18n();
	const actions = useActions();
	const preview = useStore((state) => state.filePreview);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [text, setText] = useState<FileReadView | null>(null);
	const [image, setImage] = useState<ImageView | null>(null);
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (!preview) return;
		let cancelled = false;
		setLoading(true);
		setError(null);
		setText(null);
		setImage(null);
		setCopied(false);
		const load = async () => {
			try {
				if (IMAGE_EXTENSIONS.test(preview.path)) {
					const result = await invoke<ImageView>({
						op: "files.readImage",
						workspaceId: preview.workspaceId,
						path: preview.path,
					});
					if (!cancelled) setImage(result);
				} else {
					const raw = await invoke<unknown>({
						op: "files.read",
						workspaceId: preview.workspaceId,
						path: preview.path,
					});
					if (!cancelled) setText(normalizeFileRead(raw, locale));
				}
			} catch (caught) {
				if (!cancelled) setError(errorText(caught, locale));
			} finally {
				if (!cancelled) setLoading(false);
			}
		};
		void load();
		return () => {
			cancelled = true;
		};
	}, [preview, locale]);

	if (!preview) return null;

	const close = () => actions.closeFilePreview();
	const copy = () => {
		const value = text?.content ?? "";
		if (!value) return;
		void navigator.clipboard.writeText(value).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1600);
		});
	};

	return (
		<div
			className="overlay file-preview-overlay"
			role="presentation"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) close();
			}}
		>
			<div className="file-preview" role="dialog" aria-modal="true" aria-label={t("filePreview.title")}>
				<header className="file-preview__head">
					<div className="file-preview__title">
						<Icon name="file" className="icon--sm" />
						<span className="mono truncate" title={preview.path}>
							{preview.path}
						</span>
					</div>
					<div className="file-preview__actions">
						<button
							type="button"
							className="btn btn--sm btn--ghost"
							onClick={() => void actions.openFileExternal(preview.path)}
						>
							{t("filePreview.openExternal")}
						</button>
						<button type="button" className="icon-btn" aria-label={t("common.close")} onClick={close}>
							<Icon name="close" className="icon--sm" />
						</button>
					</div>
				</header>
				<div className="file-preview__body">
					{loading ? <p className="muted">{t("filePreview.loading")}</p> : null}
					{error ? <p className="banner banner--error">{error}</p> : null}
					{!loading && !error && image ? (
						<img
							className="file-preview__image"
							src={`data:${image.mimeType};base64,${image.data}`}
							alt={preview.path}
						/>
					) : null}
					{!loading && !error && text ? (
						text.binary ? (
							<p className="muted">{t("filePreview.binary")}</p>
						) : (
							<>
								<div className="file-preview__meta">
									<span className="muted">
										{text.size !== undefined ? formatBytes(text.size, locale) : ""}
									</span>
									{text.truncated ? (
										<span className="muted">{t("filePreview.truncated")}</span>
									) : null}
									<button type="button" className="btn btn--sm btn--ghost" onClick={copy}>
										{copied ? t("common.copied") : t("common.copy")}
									</button>
								</div>
								<pre className="file-preview__text">{text.content}</pre>
							</>
						)
					) : null}
				</div>
			</div>
		</div>
	);
}
