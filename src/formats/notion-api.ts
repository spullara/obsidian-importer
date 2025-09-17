import { Notice, Setting, requestUrl, Platform } from 'obsidian';
import { FormatImporter } from '../format-importer';
import { ImportContext } from '../main';

interface NotionDatabase {
    id: string;
    title: string;
    properties: string[];
}

interface NotionPage {
    id: string;
    properties: Record<string, any>;
    created_time: string;
    last_edited_time: string;
}

export class NotionAPIImporter extends FormatImporter {
    notionToken: string = '';
    selectedDatabaseId: string = '';
    databases: NotionDatabase[] = [];
    createBaseFiles: boolean = true;

    init() {
        // Check if we're in a supported environment (desktop only for API access)
        if (!this.isEnvironmentSupported()) {
            this.notAvailable = true;
            this.modal.contentEl.createDiv('callout mod-warning', el => {
                el.createDiv('callout-title').setText('Not Available');
                el.createDiv('callout-content').setText('Notion API import requires a desktop environment with network access.');
            });
            return;
        }

        this.addOutputLocationSetting('Notion API Import');
        this.addNotionTokenSetting();
        this.addDatabaseSelector();
        this.addFormatOptions();
    }

    /**
     * Check if the current environment supports API requests
     * Notion API import requires desktop environment for network access
     */
    private isEnvironmentSupported(): boolean {
        return Platform.isDesktopApp && typeof requestUrl !== 'undefined';
    }

    private addNotionTokenSetting() {
        new Setting(this.modal.contentEl)
            .setName('Notion Integration Token')
            .setDesc('Your Notion Internal Integration Token. Create one at https://www.notion.so/my-integrations')
            .addText(text => text
                .setPlaceholder('secret_...')
                .setValue(this.notionToken)
                .onChange(async (value) => {
                    this.notionToken = value.trim();
                    if (this.notionToken) {
                        await this.loadDatabases();
                    }
                }));
    }

    private addDatabaseSelector() {
        const databaseSetting = new Setting(this.modal.contentEl)
            .setName('Database to Import')
            .setDesc('Select the Notion database you want to import');

        // Initially show loading state
        databaseSetting.addDropdown(dropdown => {
            dropdown.addOption('', 'Enter token to load databases...');
            dropdown.setDisabled(true);
        });

        // Store reference for updating later
        this.databaseSetting = databaseSetting;
    }

    private addFormatOptions() {
        new Setting(this.modal.contentEl)
            .setName('Create Obsidian Base files')
            .setDesc('Generate .base files for native Obsidian database views (requires Obsidian 1.7+)')
            .addToggle(toggle => toggle
                .setValue(this.createBaseFiles)
                .onChange(value => this.createBaseFiles = value));
    }

    /**
     * Load available databases from Notion API
     * Uses Obsidian's requestUrl to avoid CORS issues
     */
    private async loadDatabases() {
        if (!this.notionToken) return;

        try {
            const response = await requestUrl({
                url: 'https://api.notion.com/v1/search',
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.notionToken}`,
                    'Content-Type': 'application/json',
                    'Notion-Version': '2022-06-28'
                },
                body: JSON.stringify({
                    filter: { property: 'object', value: 'database' }
                })
            });

            const data = response.json;
            // Map database results to our internal format
            this.databases = data.results.map((db: any) => ({
                id: db.id,
                title: db.title?.[0]?.plain_text || 'Untitled Database',
                properties: Object.keys(db.properties || {})
            }));

            this.updateDatabaseDropdown();
        } catch (error) {
            console.error('Failed to load databases:', error);
            new Notice('Failed to load databases. Check your token and try again.');
        }
    }

    private updateDatabaseDropdown() {
        // Remove old setting and create new one
        this.databaseSetting.settingEl.remove();
        
        this.databaseSetting = new Setting(this.modal.contentEl)
            .setName('Database to Import')
            .setDesc('Select the Notion database you want to import')
            .addDropdown(dropdown => {
                if (this.databases.length === 0) {
                    dropdown.addOption('', 'No databases found');
                    dropdown.setDisabled(true);
                } else {
                    dropdown.addOption('', 'Select a database...');
                    this.databases.forEach(db => {
                        dropdown.addOption(db.id, `${db.title} (${db.properties.length} properties)`);
                    });
                    dropdown.onChange(value => {
                        this.selectedDatabaseId = value;
                    });
                }
            });
    }

    async import(ctx: ImportContext): Promise<void> {
        if (!this.notionToken) {
            new Notice('Please enter your Notion Integration Token.');
            return;
        }

        if (!this.selectedDatabaseId) {
            new Notice('Please select a database to import.');
            return;
        }

        const folder = await this.getOutputFolder();
        if (!folder) {
            new Notice('Please select a location to export to.');
            return;
        }

        const selectedDatabase = this.databases.find(db => db.id === this.selectedDatabaseId);
        if (!selectedDatabase) {
            new Notice('Selected database not found.');
            return;
        }

        try {
            ctx.status('Fetching database details...');

            // Fetch database details and pages sequentially to avoid concurrency issues
            // Following guideline: "Avoid concurrency. It's easy to accidentally run out of memory when using concurrent processing"
            const databaseDetails = await this.fetchDatabaseDetails(this.selectedDatabaseId);

            if (ctx.isCancelled()) return;

            ctx.status('Fetching database pages...');
            const pages = await this.fetchAllPages(ctx, this.selectedDatabaseId);

            if (ctx.isCancelled()) return;

            ctx.status('Converting pages to markdown...');
            const convertedFiles: string[] = [];

            // Process pages sequentially to avoid memory issues in large vaults
            // Following guideline: "Be performance minded. Your code will be used in vaults with 10,000 or even 100,000 notes"
            for (let i = 0; i < pages.length; i++) {
                if (ctx.isCancelled()) return;

                const page = pages[i];
                const fileName = await this.convertPageToMarkdown(page, folder, databaseDetails);
                if (fileName) {
                    convertedFiles.push(fileName);
                    ctx.reportNoteSuccess(fileName);
                }

                ctx.reportProgress(i + 1, pages.length + (this.createBaseFiles ? 1 : 0));
            }

            // Create .base file if requested
            if (this.createBaseFiles && !ctx.isCancelled()) {
                ctx.status('Creating Obsidian Base file...');
                const baseFileName = await this.createBaseFile(selectedDatabase, databaseDetails, pages, folder);
                if (baseFileName) {
                    convertedFiles.push(baseFileName);
                    ctx.reportNoteSuccess(baseFileName);
                }
                ctx.reportProgress(pages.length + 1, pages.length + 1);
            }

            ctx.status('Import completed successfully!');
            new Notice(`Successfully imported ${convertedFiles.length} files from ${selectedDatabase.title}`);

        } catch (error) {
            console.error('Import failed:', error);
            ctx.reportFailed(selectedDatabase.title, error);
            new Notice('Import failed. Check the console for details.');
        }
    }

    private async fetchDatabaseDetails(databaseId: string) {
        const response = await requestUrl({
            url: `https://api.notion.com/v1/databases/${databaseId}`,
            headers: {
                'Authorization': `Bearer ${this.notionToken}`,
                'Notion-Version': '2022-06-28'
            }
        });

        return response.json;
    }

    private async fetchAllPages(ctx: ImportContext, databaseId: string): Promise<NotionPage[]> {
        const pages: NotionPage[] = [];
        let hasMore = true;
        let nextCursor: string | undefined;

        while (hasMore && !ctx.isCancelled()) {
            const response = await requestUrl({
                url: `https://api.notion.com/v1/databases/${databaseId}/query`,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.notionToken}`,
                    'Content-Type': 'application/json',
                    'Notion-Version': '2022-06-28'
                },
                body: JSON.stringify({
                    start_cursor: nextCursor,
                    page_size: 100
                })
            });

            const data = response.json;
            pages.push(...data.results);

            hasMore = data.has_more;
            nextCursor = data.next_cursor;

            ctx.status(`Fetched ${pages.length} pages...`);
        }

        return pages;
    }

    private async convertPageToMarkdown(page: NotionPage, folder: any, databaseDetails: any): Promise<string | null> {
        try {
            // Get title from properties
            const titleProperty = Object.keys(databaseDetails.properties).find(
                key => databaseDetails.properties[key].type === 'title'
            );

            let title = 'Untitled';
            if (titleProperty && page.properties[titleProperty]) {
                const titleValue = page.properties[titleProperty];
                if (titleValue.title && titleValue.title.length > 0) {
                    title = titleValue.title.map((t: any) => t.plain_text).join('');
                }
            }

            // Start with frontmatter at the beginning
            let markdown = '---\n';
            markdown += `notion_id: ${page.id}\n`;
            markdown += `created: ${page.created_time}\n`;
            markdown += `updated: ${page.last_edited_time}\n`;

            // Add other properties
            for (const [key, property] of Object.entries(page.properties)) {
                if (databaseDetails.properties[key]?.type !== 'title') {
                    const value = this.extractPropertyValue(property);
                    if (value && value.toString().trim()) {
                        // Handle multi-line values and special characters for proper YAML
                        const cleanValue = String(value).replace(/\n/g, ' ').replace(/"/g, '\\"');
                        if (cleanValue.includes(':') || cleanValue.includes('\n') || cleanValue.length > 100) {
                            markdown += `${key}: "${cleanValue}"\n`;
                        } else {
                            markdown += `${key}: ${cleanValue}\n`;
                        }
                    }
                }
            }

            markdown += '---\n\n';

            // Add title and basic content
            markdown += `# ${title}\n\n`;

            // Save the file
            const fileName = this.sanitizeFilePath(title) + '.md';
            await this.saveAsMarkdownFile(folder, title, markdown);

            return fileName;
        } catch (error) {
            console.error('Error converting page:', error);
            return null;
        }
    }

    /**
     * Extract value from Notion property based on its type
     * Returns null for empty values to enable dynamic property detection
     *
     * @param property - Notion property object with type and value
     * @returns Extracted value or null if empty
     */
    private extractPropertyValue(property: any): string | number | boolean | null {
        switch (property.type) {
            case 'rich_text':
                // Rich text is an array of text objects with plain_text content
                const richText = property.rich_text?.map((text: any) => text.plain_text).join('') || '';
                return richText.trim() || null;
            case 'number':
                // Numbers can be 0, so check for null/undefined specifically
                return property.number !== null && property.number !== undefined ? property.number : null;
            case 'select':
                // Single select returns the selected option name
                return property.select?.name || null;
            case 'multi_select':
                // Multi-select returns array of selected options, join with commas
                const multiSelect = property.multi_select?.map((item: any) => item.name).join(', ') || '';
                return multiSelect.trim() || null;
            case 'date':
                // Date properties have start (and optionally end) dates
                return property.date?.start || null;
            case 'checkbox':
                // Checkboxes can be false, so check for null/undefined specifically
                return property.checkbox !== null && property.checkbox !== undefined ? property.checkbox : null;
            case 'url':
                return property.url?.trim() || null;
            case 'email':
                return property.email?.trim() || null;
            case 'phone_number':
                return property.phone_number?.trim() || null;
            case 'people':
                // People properties contain user objects with name or id
                const people = property.people?.map((person: any) => person.name || person.id).join(', ') || '';
                return people.trim() || null;
            case 'files':
                // Files can be internal (file.url) or external (external.url)
                const files = property.files?.map((file: any) => file.name || file.file?.url || file.external?.url).join(', ') || '';
                return files.trim() || null;
            case 'relation':
                // Relations are references to other pages, return their IDs
                const relations = property.relation?.map((rel: any) => rel.id).join(', ') || '';
                return relations.trim() || null;
            case 'formula':
                // Formulas contain computed values, recursively extract the result
                return this.extractPropertyValue(property.formula);
            case 'rollup':
                // Rollups aggregate values from related pages
                const rollup = property.rollup?.array?.map((item: any) => this.extractPropertyValue(item)).join(', ') || '';
                return rollup.trim() || null;
            default:
                return null;
        }
    }

    /**
     * Create Obsidian Base file for native database views
     * Only includes properties that have actual data to avoid empty columns
     * Uses file.inFolder() filtering to scope to current directory
     *
     * @param database - Database metadata
     * @param databaseDetails - Full database schema from API
     * @param pages - All pages from the database
     * @param folder - Output folder for the base file
     * @returns Base file name or null if creation failed
     */
    private async createBaseFile(database: NotionDatabase, databaseDetails: any, pages: NotionPage[], folder: any): Promise<string | null> {
        try {
            const databaseTitle = database.title;

            // Analyze actual properties that exist in the data with real values
            // This prevents empty columns in the base file table view
            const actualProperties = new Set<string>();
            for (const page of pages) {
                for (const [key, property] of Object.entries(page.properties)) {
                    // Skip title properties as they're handled separately
                    if (databaseDetails.properties[key]?.type !== 'title') {
                        const value = this.extractPropertyValue(property);
                        // Only include properties with meaningful values
                        // Note: false is a valid checkbox value, so we check specifically
                        if (value !== null && value !== undefined && value !== '' && value !== false) {
                            actualProperties.add(key);
                        }
                    }
                }
            }

            const propertiesWithData = Array.from(actualProperties);

            // Generate .base file content in YAML format
            let baseContent = `# Obsidian Base file for ${databaseTitle}\n`;
            baseContent += `# Generated from Notion API\n\n`;

            // Properties section - configure display names
            baseContent += `properties:\n`;

            // Add properties that actually have data
            for (const propName of propertiesWithData) {
                baseContent += `  ${propName}:\n`;
                baseContent += `    displayName: "${propName}"\n`;
            }

            // Add file properties
            baseContent += `  notion_id:\n`;
            baseContent += `    displayName: "Notion ID"\n`;
            baseContent += `  created:\n`;
            baseContent += `    displayName: "Created (Notion)"\n`;
            baseContent += `  updated:\n`;
            baseContent += `    displayName: "Updated (Notion)"\n\n`;

            // Views section - create a table view
            baseContent += `views:\n`;
            baseContent += `  - type: table\n`;
            baseContent += `    name: "${databaseTitle} Table"\n`;
            baseContent += `    limit: 100\n`;
            baseContent += `    filters:\n`;
            baseContent += `      and:\n`;
            baseContent += `        - file.ext == "md"\n`;
            baseContent += `        - notion_id != null\n`;
            baseContent += `        - file.inFolder(this.file.folder)\n`;
            baseContent += `    order:\n`;
            baseContent += `      - file.name\n`;

            for (const propName of propertiesWithData.slice(0, 8)) { // Limit to first 8 properties
                baseContent += `      - ${propName}\n`;
            }

            baseContent += `      - created\n`;
            baseContent += `      - updated\n\n`;

            // Add a card view as well
            baseContent += `  - type: card\n`;
            baseContent += `    name: "${databaseTitle} Cards"\n`;
            baseContent += `    limit: 50\n\n`;

            // Add instructions as comments
            baseContent += `# Instructions:\n`;
            baseContent += `# 1. This .base file creates native Obsidian database views\n`;
            baseContent += `# 2. Requires Obsidian 1.7+ with Bases feature enabled\n`;
            baseContent += `# 3. Open this file in Obsidian to see your database\n`;
            baseContent += `# 4. You can edit views, filters, and properties as needed\n`;
            baseContent += `# 5. See https://help.obsidian.md/bases/syntax for full documentation\n`;

            // Save the .base file
            const baseFileName = this.sanitizeFilePath(databaseTitle) + '.base';
            const baseFilePath = folder.path + '/' + baseFileName;

            await this.vault.create(baseFilePath, baseContent);

            return baseFileName;
        } catch (error) {
            console.error('Error creating base file:', error);
            return null;
        }
    }



    private databaseSetting: Setting;
}
