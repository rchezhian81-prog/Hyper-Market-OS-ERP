// Imported FIRST by the queue till's browser entry, before the till's own module: it tells that module this page is the
// queue handheld (D04-FR-05), so the till's module does not boot a fixed till of its own at load. ES modules evaluate in
// import order, so this flag is set before `apps/pos/src/browser-entry.ts` reads it.
(globalThis as { sreQueueTill?: boolean }).sreQueueTill = true;
export {};
