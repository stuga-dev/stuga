/** Every namespace of this language, bundled as one chunk the app loads when it runs in it. */
const files = import.meta.glob<Record<string, string>>("./*.json", { eager: true, import: "default" });

export default Object.fromEntries(Object.entries(files).map(([path, messages]) => [path.slice("./".length, -".json".length), messages]));
