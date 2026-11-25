import { EditorView } from '@codemirror/view';
import { around } from 'monkey-around';
import {
	MarkdownView,
	TFile,
	type CachedMetadata,
	type HeadingCache,
	type View,
	type WorkspaceLeaf,
} from 'obsidian';
import type LiteratureBlocksPlugin from './main';
import { parsePaperContent, scanPaperBlocks } from './codeblocks/paper';
import { WIDGET_CLASS } from './codeblocks/paper-editor';

/*
 * Lists paper cards in Obsidian's core Outline view, nested under the heading
 * they sit below.
 *
 * The public plugin API (checked up to 1.14.4) cannot add entries to the core
 * outline, which only reads real headings from the metadata cache. So this
 * wraps two internal methods of that view, `getHeadings` and `createItemDom`.
 * If an Obsidian update removes them, the outline shows headings only.
 */

const OUTLINE_VIEW_TYPE = 'outline';
const OUTLINE_ITEM_CLASS = 'literature-blocks-outline-item';
const FLASH_CLASS = 'is-outline-target';
const FLASH_MS = 1500;

interface PaperHeading extends HeadingCache {
	isPaper: true;
}

/** The parts of the core outline view this module relies on. */
interface OutlineView extends View {
	file: TFile | null;
	getHeadings(): HeadingCache[];
	createItemDom(heading: HeadingCache): { selfEl: HTMLElement };
	update(): void;
	findCorrespondingLeaf(): WorkspaceLeaf | null;
}

function isOutlineView(view: View): view is OutlineView {
	const candidate = view as Partial<OutlineView>;
	return view.getViewType() === OUTLINE_VIEW_TYPE
		&& typeof candidate.getHeadings === 'function'
		&& typeof candidate.createItemDom === 'function'
		&& typeof candidate.update === 'function';
}

/** Outline entries for the paper blocks in `text`, in document order. */
function findPaperHeadings(text: string, cache: CachedMetadata): PaperHeading[] {
	const lines = text.split(/\r?\n/);
	// Only trust blocks Obsidian also parsed as code, which rules out fences
	// quoted inside another code block.
	const codeSections = new Map(
		(cache.sections ?? [])
			.filter((section) => section.type === 'code')
			.map((section) => [section.position.start.line, section.position]),
	);

	const headings: PaperHeading[] = [];
	for (const { startLine, endLine } of scanPaperBlocks(lines.length, (lineNumber) => lines[lineNumber - 1] ?? '')) {
		const position = codeSections.get(startLine - 1);
		if (!position) continue;
		const { title } = parsePaperContent(lines.slice(startLine, endLine - 1).join('\n'));
		headings.push({ heading: title || 'Untitled', level: 1, position, isPaper: true });
	}
	return headings;
}

/** Interleaves papers with headings, one level below the heading above each. */
function mergeHeadings(headings: HeadingCache[], papers: PaperHeading[]): HeadingCache[] {
	if (papers.length === 0) return headings;
	const merged: HeadingCache[] = [];
	let next = 0;
	let parentLevel = 0;
	for (const paper of papers) {
		for (; next < headings.length; next++) {
			const heading = headings[next]!;
			if (heading.position.start.line > paper.position.start.line) break;
			merged.push(heading);
			parentLevel = heading.level;
		}
		merged.push({ ...paper, level: parentLevel + 1 });
	}
	return merged.concat(headings.slice(next));
}

/**
 * Scrolls a live preview editor to a rendered card. Obsidian's own outline
 * jump puts the cursor on the target line, which would flip the card back to
 * its source. Returns false when the default jump should run instead.
 */
function jumpToCard(outline: OutlineView, heading: HeadingCache): boolean {
	const leaf = outline.findCorrespondingLeaf();
	const view = leaf?.view;
	if (!leaf || !(view instanceof MarkdownView) || view.getMode() !== 'source') return false;
	if ((view.getState() as { source?: boolean }).source) return false;
	// `editor.cm` is the CodeMirror view behind Obsidian's Editor wrapper.
	const cm = (view.editor as { cm?: unknown }).cm;
	if (!(cm instanceof EditorView)) return false;

	const line = heading.position.start.line + 1;
	if (line > cm.state.doc.lines) return false;
	const pos = cm.state.doc.line(line).from;

	outline.app.workspace.setActiveLeaf(leaf, { focus: true });
	cm.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 60 }) });
	cm.requestMeasure({
		read: () => Array.from(cm.contentDOM.querySelectorAll<HTMLElement>(`.${WIDGET_CLASS}`))
			.find((el) => cm.posAtDOM(el) === pos),
		write: (el) => {
			if (!el) return;
			el.addClass(FLASH_CLASS);
			window.setTimeout(() => el.removeClass(FLASH_CLASS), FLASH_MS);
		},
	});
	return true;
}

export function registerPaperOutline(plugin: LiteratureBlocksPlugin): void {
	const { app } = plugin;
	const { workspace, metadataCache } = app;
	// Keyed by cache object: Obsidian makes a new one whenever a note changes.
	const papersByCache = new WeakMap<CachedMetadata, PaperHeading[] | Promise<void>>();

	const outlineViews = () => workspace.getLeavesOfType(OUTLINE_VIEW_TYPE)
		.map((leaf) => leaf.view)
		.filter(isOutlineView);

	const refresh = (file?: TFile) => {
		for (const view of outlineViews()) {
			if (!file || view.file === file) view.update();
		}
	};

	/** Papers for a note, or null while its text is still being read. */
	const papersFor = (file: TFile, cache: CachedMetadata): PaperHeading[] | null => {
		const known = papersByCache.get(cache);
		if (Array.isArray(known)) return known;
		if (!known) {
			papersByCache.set(cache, app.vault.cachedRead(file).then((text) => {
				const papers = findPaperHeadings(text, cache);
				papersByCache.set(cache, papers);
				if (papers.length > 0) refresh(file);
			}).catch((err) => {
				papersByCache.set(cache, []);
				console.warn('Literature Blocks: could not read papers for the outline', err);
			}));
		}
		return null;
	};

	const patchOutline = (view: OutlineView) => around(Object.getPrototypeOf(view) as OutlineView, {
		getHeadings: (next) => function (this: OutlineView) {
			const headings = next.call(this);
			const file = this.file;
			const cache = file?.extension === 'md' ? metadataCache.getFileCache(file) : null;
			const papers = file && cache ? papersFor(file, cache) : null;
			return papers ? mergeHeadings(headings, papers) : headings;
		},
		createItemDom: (next) => function (this: OutlineView, heading: HeadingCache) {
			const item = next.call(this, heading);
			if ('isPaper' in heading) {
				item.selfEl.addClass(OUTLINE_ITEM_CLASS);
				// Capture phase, so this runs before Obsidian's own click handler.
				item.selfEl.addEventListener('click', (event) => {
					if (event.target instanceof Element && event.target.closest('.collapse-icon')) return;
					if (jumpToCard(this, heading)) event.stopImmediatePropagation();
				}, true);
			}
			return item;
		},
	});

	// The outline view class is only reachable through a loaded outline view,
	// which may not exist yet (the sidebar tab can be deferred or closed).
	let unpatch: (() => void) | null = null;
	const tryPatch = () => {
		const view = unpatch ? undefined : outlineViews()[0];
		if (!view) return;
		unpatch = patchOutline(view);
		refresh();
	};

	plugin.registerEvent(metadataCache.on('changed', (_file, data, cache) => {
		// Obsidian debounces the outline redraw, so this lands before it.
		papersByCache.set(cache, findPaperHeadings(data, cache));
	}));
	plugin.registerEvent(workspace.on('layout-change', tryPatch));
	plugin.registerEvent(workspace.on('active-leaf-change', tryPatch));
	workspace.onLayoutReady(tryPatch);

	plugin.register(() => {
		unpatch?.();
		refresh();
	});
}
