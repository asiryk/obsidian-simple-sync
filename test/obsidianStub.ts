// The real "obsidian" package ships types only, with no runtime entry point.
// Vitest aliases it here so modules that import its classes can be loaded.

export class App {}

export class Modal {
    contentEl: any = null;
    constructor(public app: any) {}
    open(): void {}
    close(): void {}
}

export class Notice {
    constructor(public message: string | DocumentFragment) {}
}

export class Plugin {
    constructor(
        public app: any,
        public manifest: any
    ) {}
}

export class PluginSettingTab {
    containerEl: any = null;
    constructor(
        public app: any,
        public plugin: any
    ) {}
}

export class Setting {
    constructor(public containerEl: any) {}
    setName(): this {
        return this;
    }
    setDesc(): this {
        return this;
    }
    addText(): this {
        return this;
    }
    addToggle(): this {
        return this;
    }
    addButton(): this {
        return this;
    }
    addTextArea(): this {
        return this;
    }
}
