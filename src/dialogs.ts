// Electron file dialogs / shell plus DOM file-picker fallbacks (desktop-only).

// getElectronDialog - reach the Electron file dialog from the Obsidian renderer.
// Uses window.require so esbuild does not try to resolve the modules at build
// time. Returns null on platforms where it is unavailable.
export function getElectronDialog(): {
  showSaveDialog: (opts: unknown) => Promise<{ canceled: boolean; filePath?: string }>;
  showOpenDialog: (opts: unknown) => Promise<{ canceled: boolean; filePaths?: string[] }>;
} | null {
  const req = (window as unknown as { require?: (m: string) => unknown }).require;
  if (typeof req !== "function") {
    return null;
  }
  for (const mod of ["@electron/remote", "electron"]) {
    try {
      const m = req(mod) as { dialog?: unknown; remote?: { dialog?: unknown } };
      const dialog = m?.dialog ?? m?.remote?.dialog;
      if (dialog) {
        return dialog as ReturnType<typeof getElectronDialog>;
      }
    } catch {
      // try the next module
    }
  }
  return null;
}

// getElectronShell - the Electron shell module (renderer-safe) for revealing a
// file/folder in the OS file manager. Returns null where unavailable.
export function getElectronShell(): {
  showItemInFolder: (fullPath: string) => void;
  openPath: (p: string) => Promise<string>;
} | null {
  const req = (window as unknown as { require?: (m: string) => unknown }).require;
  if (typeof req !== "function") {
    return null;
  }
  try {
    const electron = req("electron") as { shell?: ReturnType<typeof getElectronShell> };
    return electron?.shell ?? null;
  } catch {
    return null;
  }
}

// pickExistingFile - fallback picker (Electron adds `.path` to the File object).
export function pickExistingFile(accept: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (accept) {
      input.accept = accept;
    }
    input.addEventListener("change", () => {
      const file = input.files?.[0] as (File & { path?: string }) | undefined;
      resolve(file?.path ?? null);
    });
    input.click();
  });
}

// browseForContainer - let the user choose where the .tvlt container lives, via
// the native save dialog when available, otherwise picking an existing file.
export async function browseForContainer(defaultPath: string): Promise<string | null> {
  const dialog = getElectronDialog();
  if (dialog) {
    try {
      const result = await dialog.showSaveDialog({
        title: "Choose TVault container location",
        defaultPath: defaultPath || undefined,
        filters: [{ name: "TVault container", extensions: ["tvlt"] }],
      });
      return result && !result.canceled && result.filePath ? result.filePath : null;
    } catch {
      // fall through to the input fallback
    }
  }
  return pickExistingFile(".tvlt");
}

// browseForExistingFile - pick an existing file (e.g. a saved token file) via
// the native open dialog, falling back to a hidden <input type=file>.
export async function browseForExistingFile(
  title: string,
  defaultPath: string,
  extensions: string[],
): Promise<string | null> {
  const dialog = getElectronDialog();
  if (dialog) {
    try {
      const result = await dialog.showOpenDialog({
        title,
        defaultPath: defaultPath || undefined,
        properties: ["openFile"],
        filters: [{ name: "TVault tokens", extensions }],
      });
      return result && !result.canceled && result.filePaths && result.filePaths[0]
        ? result.filePaths[0]
        : null;
    } catch {
      // fall through to the input fallback
    }
  }
  return pickExistingFile(extensions.map((e) => `.${e}`).join(","));
}
