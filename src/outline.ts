import { EditorView } from '@codemirror/view';
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
 * Shows paper cards in Obsidian's core Outline view, nested under the heading
 * they sit below.
 *
 * Obsidian has no API for this, so it wraps two methods of the core outline
 * view (`getHeadings` and `createItemDom`). Both are internal: if a future
 * Obsidian version drops them, the outline simply goes back to headings only.
 */

const OUTLINE_VIEW_TYPE = 'outline';
const OUTLINE_ITEM_CLASS = 'literature-blocks-outline-item';
const FLASH_CLASS = 'is-outline-target';

interface OutlineItem {
	selfEl: HTMLElement;
}

/** The parts of the core outline view this module relies on. */
interface OutlineView extends View {
	file: TFile | null;
	getHeadings(): HeadingCache[];
	createItemDom(heading: HeadingCache): OutlineItem;
	update(): void;
	findCorrespondingLeaf(): WorkspaceLeaf | null;
}

type OutlinePrototype = Pick<OutlineView, 'getHeadings' | 'createItemDom'>;

function isOutlineView(view: View): view is OutlineView {
	const candidate = view as Partial<OutlineView>;
	return view.getViewType() === OUTLINE_VIEW_TYPE
		&& typeof candidate.getHeadings === 'function'
		&& typeof candidate.createItemDom === 'function'
		&& typeof candidate.update === 'function';
}

/** Outline entries for the paper blocks in `text`. Levels are filled in on merge. */
function findPaperHeadings(text: string, cache: CachedMetadata): HeadingCache[] {
	const lines = text.split('\n');
	const lineText = (lineNumber: number) => (lines[lineNumber - 1] ?? '').replace(/\r$/, '');
	const blocks = scanPaperBlocks(lines.length, lineText);
	if (blocks.length === 0) return [];

	// Only trust blocks Obsidian also parsed as code, which rules out fences
	// quoted inside another code block.
	const codeStarts = cache.sections
		? new Set(cache.sections.filter((section) => section.type === 'code').map((section) => section.position.start.line))
		: null;

	const lineOffsets: number[] = [];
	let offset = 0;
	for (const line of lines) {
		lineOffsets.push(offset);
		offset += line.length + 1;
	}

	const headings: HeadingCache[] = [];
	for (const { startLine, endLine } of blocks) {
		const start = startLine - 1;
		const end = endLine - 1;
		if (codeStarts && !codeStarts.has(start)) continue;

		const source = lines.slice(start + 1, end).map((line) => line.replace(/\r$/, '')).join('\n');
		const endCol = lineText(endLine).length;
		headings.push({
			heading: parsePaperContent(source).title || 'Untitled',
			level: 1,
			position: {
				start: { line: start, col: 0, offset: lineOffsets[start] ?? 0 },
				end: { line: end, col: endCol, offset: (lineOffsets[end] ?? 0) + endCol },
			},
		});
	}
	return headings;
}

export function registerPaperOutline(plugin: LiteratureBlocksPlugin): void {
	const { app } = plugin;
	const papersByCache = new WeakMap<CachedMetadata, HeadingCache[]>();
	const loading = new WeakSet<CachedMetadata>();
	const paperHeadings = new WeakSet<HeadingCache>();
	let unpatch: (() => void) | null = null;

	const outlineViews = (): OutlineView[] => app.workspace.getLeavesOfType(OUTLINE_VIEW_TYPE)
		.map((leaf) => leaf.view)
		.filter(isOutlineView);

	const refresh = (file?: TFile) => {
		for (const view of outlineViews()) {
			if (!file || view.file === file) view.update();
		}
	};

	/** Used when a note's outline is drawn before its text has been seen. */
	const loadPapers = async (file: TFile, cache: CachedMetadata) => {
		if (loading.has(cache)) return;
		loading.add(cache);
		try {
			const papers = findPaperHeadings(await app.vault.cachedRead(file), cache);
			papersByCache.set(cache, papers);
			if (papers.length > 0) refresh(file);
		} catch (err) {
			console.warn('Literature Blocks: could not read papers for the outline', err);
		} finally {
			loading.delete(cache);
		}
	};

	/** Interleaves papers with headings, one level below the heading above each. */
	const mergeHeadings = (headings: HeadingCache[], papers: HeadingCache[]): HeadingCache[] => {
		if (papers.length === 0) return headings;
		const merged: HeadingCache[] = [];
		let headingIndex = 0;
		let parentLevel = 0;
		for (const paper of papers) {
			for (; headingIndex < headings.length; headingIndex++) {
				const heading = headings[headingIndex]!;
				if (heading.position.start.line > paper.position.start.line) break;
				merged.push(heading);
				parentLevel = heading.level;
			}
			const entry = { ...paper, level: parentLevel + 1 };
			paperHeadings.add(entry);
			merged.push(entry);
		}
		return merged.concat(headings.slice(headingIndex));
	};

	/** Scrolls to a rendered card without moving the cursor into it. */
	const jumpToCard = (outline: OutlineView, heading: HeadingCache): boolean => {
		const leaf = outline.findCorrespondingLeaf();
		const view = leaf?.view;
		if (!leaf || !(view instanceof MarkdownView) || view.getMode() !== 'source') return false;
		if ((view.getState() as { source?: boolean }).source) return false;
		const cm = (view.editor as { cm?: unknown }).cm;
		if (!(cm instanceof EditorView)) return false;

		const line = heading.position.start.line + 1;
		if (line > cm.state.doc.lines) return false;
		const pos = cm.state.doc.line(line).from;

		app.workspace.setActiveLeaf(leaf, { focus: true });
		cm.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 60 }) });
		cm.requestMeasure({
			read: () => Array.from(cm.contentDOM.querySelectorAll<HTMLElement>(`.${WIDGET_CLASS}`))
				.find((el) => cm.posAtDOM(el) === pos),
			write: (el) => {
				if (!el) return;
				el.addClass(FLASH_CLASS);
				window.setTimeout(() => el.removeClass(FLASH_CLASS), 1500);
			},
		});
		return true;
	};

	const patch = (proto: OutlinePrototype) => {
		const originalGetHeadings = proto.getHeadings;
		const originalCreateItemDom = proto.createItemDom;

		proto.getHeadings = function (this: OutlineView): HeadingCache[] {
			const headings = originalGetHeadings.call(this);
			const file = this.file;
			if (!(file instanceof TFile) || file.extension !== 'md') return headings;
			const cache = app.metadataCache.getFileCache(file);
			if (!cache) return headings;
			const papers = papersByCache.get(cache);
			if (!papers) {
				void loadPapers(file, cache);
				return headings;
			}
			return mergeHeadings(headings, papers);
		};

		proto.createItemDom = function (this: OutlineView, heading: HeadingCache): OutlineItem {
			const item = originalCreateItemDom.call(this, heading);
			if (paperHeadings.has(heading)) {
				item.selfEl.addClass(OUTLINE_ITEM_CLASS);
				// Obsidian's own click handler puts the cursor on the target
				// line, which would flip the card back to its source.
				item.selfEl.addEventListener('click', (event) => {
					if ((event.target as Element | null)?.closest?.('.collapse-icon')) return;
					if (jumpToCard(this, heading)) event.stopImmediatePropagation();
				}, true);
			}
			return item;
		};

		return () => {
			proto.getHeadings = originalGetHeadings;
			proto.createItemDom = originalCreateItemDom;
		};
	};

	/** The outline view class only becomes reachable once an outline is shown. */
	const tryPatch = () => {
		if (unpatch) return;
		const view = outlineViews()[0];
		if (!view) return;
		let proto = Object.getPrototypeOf(view) as OutlinePrototype | null;
		while (proto && !Object.prototype.hasOwnProperty.call(proto, 'getHeadings')) {
			proto = Object.getPrototypeOf(proto) as OutlinePrototype | null;
		}
		if (!proto) return;
		unpatch = patch(proto);
		refresh();
	};

	plugin.registerEvent(app.metadataCache.on('changed', (_file, data, cache) => {
		// Runs before the outline redraws, which Obsidian debounces.
		papersByCache.set(cache, findPaperHeadings(data, cache));
	}));
	plugin.registerEvent(app.workspace.on('layout-change', tryPatch));
	plugin.registerEvent(app.workspace.on('active-leaf-change', tryPatch));
	app.workspace.onLayoutReady(tryPatch);

	plugin.register(() => {
		unpatch?.();
		unpatch = null;
		refresh();
	});
}
