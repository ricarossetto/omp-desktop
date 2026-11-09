import { useT } from "../../i18n";
import { useStore } from "../../store/context";
import "./settings.css";

export function AboutTab() {
	const t = useT();
	const runtime = useStore((state) => state.runtime);
	const unavailable = t("settings.about.unavailable");
	const signed =
		runtime?.signed === true
			? t("settings.about.signedYes")
			: runtime?.signed === false
				? t("settings.about.signedNo")
				: unavailable;

	return (
		<section className="omp-settings-section" aria-labelledby="omp-about-title">
			<h3 id="omp-about-title">{t("settings.about.title")}</h3>
			<p className="omp-muted">{t("settings.about.body")}</p>
			<dl className="omp-about">
				<div>
					<dt>{t("settings.about.version")}</dt>
					<dd>{runtime?.appVersion ?? unavailable}</dd>
				</div>
				<div>
					<dt>{t("settings.about.omp")}</dt>
					<dd>{runtime?.ompVersion ?? unavailable}</dd>
				</div>
				<div>
					<dt>{t("settings.about.bun")}</dt>
					<dd className="mono omp-about__path">{runtime?.bunPath ?? unavailable}</dd>
				</div>
				<div>
					<dt>{t("settings.about.platform")}</dt>
					<dd>{runtime?.platform ?? unavailable}</dd>
				</div>
				<div>
					<dt>{t("settings.about.signed")}</dt>
					<dd>{signed}</dd>
				</div>
				<div>
					<dt>{t("settings.about.license")}</dt>
					<dd>MIT</dd>
				</div>
			</dl>
		</section>
	);
}
