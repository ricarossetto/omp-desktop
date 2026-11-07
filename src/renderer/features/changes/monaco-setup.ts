/**
 * Monaco local: usa o pacote instalado (sem CDN) e workers emitidos pelo Vite.
 * Chamado antes de montar qualquer editor.
 */
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import cssWorker from "monaco-editor/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/language/json/json.worker?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker?worker";

let configured = false;

function installWorkerFactory(): void {
	const scope = self as unknown as {
		MonacoEnvironment?: { getWorker(moduleId: string, label: string): Worker };
	};
	if (scope.MonacoEnvironment?.getWorker) return;
	scope.MonacoEnvironment = {
		getWorker(_moduleId: string, label: string): Worker {
			switch (label) {
				case "json":
					return new jsonWorker();
				case "css":
				case "scss":
				case "less":
					return new cssWorker();
				case "html":
				case "handlebars":
				case "razor":
					return new htmlWorker();
				case "typescript":
				case "javascript":
					return new tsWorker();
				default:
					return new editorWorker();
			}
		},
	};
}

export const MONACO_THEME_DARK = "omp-dark";
export const MONACO_THEME_LIGHT = "omp-light";

function defineThemes(): void {
	monaco.editor.defineTheme(MONACO_THEME_DARK, {
		base: "vs-dark",
		inherit: true,
		rules: [],
		colors: {
			"editor.background": "#191C1F",
			"editor.foreground": "#E6E8EA",
			"editor.lineHighlightBackground": "#20252B",
			"editorLineNumber.foreground": "#53606D",
			"editorLineNumber.activeForeground": "#A4AAB2",
			"editorGutter.background": "#191C1F",
			"diffEditor.insertedTextBackground": "#63BD8D22",
			"diffEditor.removedTextBackground": "#E37F7F22",
			"diffEditor.insertedLineBackground": "#63BD8D14",
			"diffEditor.removedLineBackground": "#E37F7F14",
			"scrollbarSlider.background": "#32383F99",
			"scrollbarSlider.hoverBackground": "#53606D99",
		},
	});
	monaco.editor.defineTheme(MONACO_THEME_LIGHT, {
		base: "vs",
		inherit: true,
		rules: [],
		colors: {
			"editor.background": "#FFFFFF",
			"editor.foreground": "#20252B",
			"editor.lineHighlightBackground": "#F7F8FA",
			"editorLineNumber.foreground": "#53606D",
			"editorLineNumber.activeForeground": "#20252B",
			"editorGutter.background": "#FFFFFF",
			"diffEditor.insertedTextBackground": "#2E7D4F22",
			"diffEditor.removedTextBackground": "#B33A3A22",
			"diffEditor.insertedLineBackground": "#2E7D4F14",
			"diffEditor.removedLineBackground": "#B33A3A14",
			"scrollbarSlider.background": "#CCD2D999",
			"scrollbarSlider.hoverBackground": "#53606D99",
		},
	});
}

/** Configura loader/workers uma única vez. */
export function ensureMonaco(): typeof monaco {
	if (!configured) {
		configured = true;
		installWorkerFactory();
		defineThemes();
		loader.config({ monaco });
	}
	return monaco;
}
