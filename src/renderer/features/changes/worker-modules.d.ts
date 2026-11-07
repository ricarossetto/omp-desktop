// Workers do Monaco emitidos pelo Vite (sintaxe `?worker`). Declarações
// específicas evitam conflito com o wildcard de `vite/client`.
declare module "monaco-editor/editor/editor.worker?worker" {
	const WorkerFactory: new () => Worker;
	export default WorkerFactory;
}
declare module "monaco-editor/language/json/json.worker?worker" {
	const WorkerFactory: new () => Worker;
	export default WorkerFactory;
}
declare module "monaco-editor/language/css/css.worker?worker" {
	const WorkerFactory: new () => Worker;
	export default WorkerFactory;
}
declare module "monaco-editor/language/html/html.worker?worker" {
	const WorkerFactory: new () => Worker;
	export default WorkerFactory;
}
declare module "monaco-editor/language/typescript/ts.worker?worker" {
	const WorkerFactory: new () => Worker;
	export default WorkerFactory;
}
