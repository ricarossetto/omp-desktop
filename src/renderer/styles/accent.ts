/** Acento personalizado: deriva as variantes usadas por foco, seleção e xterm. */

type Rgb = [number, number, number];

function parseHex(value: string): Rgb | null {
	const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
	if (!match) return null;
	const digits = match[1];
	const expanded =
		digits.length === 3
			? digits
					.split("")
					.map((char) => char + char)
					.join("")
			: digits;
	return [
		Number.parseInt(expanded.slice(0, 2), 16),
		Number.parseInt(expanded.slice(2, 4), 16),
		Number.parseInt(expanded.slice(4, 6), 16),
	];
}

function toHex(rgb: Rgb): string {
	return `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function lighten(rgb: Rgb, amount: number): Rgb {
	return [
		Math.round(rgb[0] + (255 - rgb[0]) * amount),
		Math.round(rgb[1] + (255 - rgb[1]) * amount),
		Math.round(rgb[2] + (255 - rgb[2]) * amount),
	];
}

function darken(rgb: Rgb, amount: number): Rgb {
	return [
		Math.round(rgb[0] * (1 - amount)),
		Math.round(rgb[1] * (1 - amount)),
		Math.round(rgb[2] * (1 - amount)),
	];
}

const ACCENT_PROPERTIES = [
	"--accent",
	"--accent-strong",
	"--accent-soft",
	"--accent-glow",
	"--accent-deep",
	"--accent-contrast",
] as const;

export function applyAccent(accent: string | null): void {
	const root = document.documentElement;
	const rgb = accent ? parseHex(accent) : null;
	if (!rgb) {
		for (const property of ACCENT_PROPERTIES) root.style.removeProperty(property);
		return;
	}
	const [red, green, blue] = rgb;
	const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
	root.style.setProperty("--accent", toHex(rgb));
	root.style.setProperty("--accent-strong", toHex(lighten(rgb, 0.2)));
	root.style.setProperty("--accent-soft", `rgba(${red}, ${green}, ${blue}, 0.14)`);
	root.style.setProperty("--accent-glow", `rgba(${red}, ${green}, ${blue}, 0.45)`);
	root.style.setProperty("--accent-deep", toHex(darken(rgb, 0.2)));
	root.style.setProperty("--accent-contrast", luminance > 0.6 ? "#0e1013" : "#ffffff");
}
