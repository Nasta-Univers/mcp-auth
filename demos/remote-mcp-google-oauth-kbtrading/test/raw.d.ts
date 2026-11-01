// Vite serves a file's text for `import text from "path?raw"`.
declare module "*?raw" {
	const content: string;
	export default content;
}
