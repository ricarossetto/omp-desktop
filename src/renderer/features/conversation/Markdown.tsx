import { isValidElement, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "../../components/Icon";
import { useT } from "../../i18n";

function nodesToText(node: ReactNode): string {
	if (node === null || node === undefined || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(nodesToText).join("");
	if (isValidElement<{ children?: ReactNode }>(node)) return nodesToText(node.props.children);
	return "";
}

function CodeBlock({ children }: { children?: ReactNode }) {
	const t = useT();
	const [copied, setCopied] = useState(false);
	const text = nodesToText(children).replace(/\n$/, "");
	const language =
		isValidElement<{ className?: string }>(children) && typeof children.props.className === "string"
			? children.props.className.replace(/^language-/, "")
			: "";

	const copy = () => {
		void navigator.clipboard.writeText(text).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1600);
		});
	};

	return (
		<div className="codeblock">
			<div className="codeblock__bar">
				<span className="codeblock__language">{language || t("markdown.code")}</span>
				<button type="button" className="btn btn--sm btn--ghost" onClick={copy} aria-label={t("markdown.copyBlockAria")}>
					<Icon name={copied ? "check" : "copy"} className="icon--sm" />
					{copied ? t("common.copied") : t("common.copy")}
				</button>
			</div>
			<pre className="codeblock__pre">{children}</pre>
		</div>
	);
}

export interface MarkdownProps {
	text: string;
	onOpenLink?: (href: string) => void;
}

/**
 * Markdown sem HTML cru. Links só abrem por clique (o chamador valida o destino).
 * Imagens remotas não são carregadas pela CSP; viram link textual.
 */
export function Markdown({ text, onOpenLink }: MarkdownProps) {
	const t = useT();
	const components = useMemo(
		() => ({
			a: ({ href, children }: { href?: string; children?: ReactNode }) => (
				<a
					href={href ?? "#"}
					onClick={(event) => {
						event.preventDefault();
						if (href) onOpenLink?.(href);
					}}
				>
					{children}
				</a>
			),
			img: ({ src, alt }: { src?: string; alt?: string }) => {
				if (typeof src === "string" && (src.startsWith("data:") || src.startsWith("blob:"))) {
					return <img className="markdown__image" src={src} alt={alt ?? ""} loading="lazy" />;
				}
				return (
					<button
						type="button"
						className="markdown__remote-image"
						onClick={() => {
							if (typeof src === "string") onOpenLink?.(src);
						}}
					>
						<Icon name="image" className="icon--sm" />
						{alt || src || t("markdown.externalImage")}
					</button>
				);
			},
			pre: ({ children }: { children?: ReactNode }) => <CodeBlock>{children}</CodeBlock>,
		}),
		[onOpenLink, t],
	);

	return (
		<div className="markdown">
			<ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
				{text}
			</ReactMarkdown>
		</div>
	);
}
