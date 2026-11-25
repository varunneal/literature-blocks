import { Editor, MarkdownView, Plugin } from 'obsidian';
import { createPaperEditorExtension } from './codeblocks/paper-editor';
import { registerPaperReadingProcessor } from './codeblocks/paper-reading';
import { registerPaperOutline } from './outline';
import { LiteratureBlocksSettings, LiteratureBlocksSettingTab, DEFAULT_SETTINGS } from './settings';

export default class LiteratureBlocksPlugin extends Plugin {
	settings: LiteratureBlocksSettings = DEFAULT_SETTINGS;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new LiteratureBlocksSettingTab(this.app, this));

		registerPaperReadingProcessor(this);
		this.registerEditorExtension(createPaperEditorExtension(this));
		registerPaperOutline(this);

		this.addCommand({
			id: 'insert-paper',
			name: 'Insert paper',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				const cursor = editor.getCursor();
				const template = [
					'```paper',
					'title: ',
					'authors: ',
					'date: ',
					'link: ',
					'```'
				].join('\n');
				editor.replaceSelection(template);
				// Position cursor after "title: "
				editor.setCursor({ line: cursor.line + 1, ch: 7 });
			}
		});
	}

	async loadSettings() {
		const savedSettings = await this.loadData() as Partial<LiteratureBlocksSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
