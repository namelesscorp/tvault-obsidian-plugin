import { App, Modal, Notice } from "obsidian";
import { createHash, randomBytes } from "crypto";

export class SecretModal extends Modal {
  private value = "";
  private readonly titleText: string;
  private readonly detail: string;
  private readonly resolveValue: (value: string | null) => void;
  private settled = false;

  constructor(
    app: App,
    title: string,
    detail: string,
    resolveValue: (value: string | null) => void,
  ) {
    super(app);
    this.titleText = title;
    this.detail = detail;
    this.resolveValue = resolveValue;
  }

  onOpen(): void {
    this.titleEl.setText(this.titleText);
    this.contentEl.createEl("p", { text: this.detail });
    const input = this.contentEl.createEl("input", {
      type: "password",
      cls: "tvault-secret-input",
      attr: { autocomplete: "current-password", placeholder: "Passphrase" },
    });
    input.addEventListener("input", () => {
      this.value = input.value;
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.submit();
      }
    });

    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const submit = buttons.createEl("button", { text: "Continue", cls: "mod-cta" });
    submit.addEventListener("click", () => this.submit());
    input.focus();
  }

  private submit(): void {
    if (!this.value) {
      new Notice("Passphrase is required");
      return;
    }
    this.settled = true;
    this.resolveValue(this.value);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    this.value = "";
    if (!this.settled) {
      this.resolveValue(null);
    }
  }
}

export class ConfirmModal extends Modal {
  private readonly titleText: string;
  private readonly body: string;
  private readonly confirmText: string;
  private readonly resolveValue: (confirmed: boolean) => void;
  private settled = false;

  constructor(
    app: App,
    titleText: string,
    body: string,
    confirmText: string,
    resolveValue: (confirmed: boolean) => void,
  ) {
    super(app);
    this.titleText = titleText;
    this.body = body;
    this.confirmText = confirmText;
    this.resolveValue = resolveValue;
  }

  onOpen(): void {
    this.titleEl.setText(this.titleText);
    this.contentEl.createEl("p", { text: this.body, cls: "tvault-danger" });
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const confirm = buttons.createEl("button", {
      text: this.confirmText,
      cls: "mod-warning",
    });
    confirm.addEventListener("click", () => {
      this.settled = true;
      this.resolveValue(true);
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) {
      this.resolveValue(false);
    }
  }
}

// EntropyModal - gather user entropy by drawing in a box. The collected pointer
// samples (position, movement, timing) are hashed together with the system
// CSPRNG, so the resulting 256-bit passphrase is never weaker than
// crypto.randomBytes alone — the drawing only adds entropy, it cannot subtract.
export class EntropyModal extends Modal {
  private readonly resolveValue: (passphrase: string | null) => void;
  private readonly samples: number[] = [];
  private readonly target = 400; // pointer moves (5 numbers each) before the bar fills
  private settled = false;
  private bar: HTMLElement | null = null;
  private progressLabel: HTMLElement | null = null;

  constructor(app: App, resolveValue: (passphrase: string | null) => void) {
    super(app);
    this.resolveValue = resolveValue;
  }

  onOpen(): void {
    this.titleEl.setText("Gather entropy");
    this.contentEl.createEl("p", {
      text: "Draw with the pointer inside the box until the bar is full. This mixes your randomness into the vault key.",
    });

    const cssW = 460;
    const cssH = 200;
    const wrap = this.contentEl.createDiv({ cls: "tvault-entropy-wrap" });
    const box = wrap.createDiv({ cls: "tvault-entropy-box" });
    const canvas = box.createEl("canvas", { cls: "tvault-entropy-canvas" });
    // Match the backing store to the device pixel ratio so the trail is crisp
    // and strokes join smoothly instead of scattering into dots.
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext("2d");
    const accent =
      getComputedStyle(this.contentEl).getPropertyValue("--interactive-accent").trim() || "#3361d8";
    if (ctx) {
      ctx.scale(dpr, dpr);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = accent;
    }

    const track = wrap.createDiv({ cls: "tvault-entropy-track" });
    track.style.width = `${cssW}px`;
    this.bar = track.createDiv({ cls: "tvault-entropy-bar" });
    this.progressLabel = wrap.createEl("p", {
      cls: "tvault-hint tvault-entropy-label",
      text: "Keep drawing… 0%",
    });

    let last: [number, number] | null = null;
    let lastBar = 0;
    const onMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      // performance.now() is monotonic and adds timing jitter as entropy.
      this.samples.push(x, y, event.movementX, event.movementY, performance.now());
      if (ctx) {
        // A continuous stroke from the previous point — the smooth trail the
        // original tvault draws, rather than disconnected dots.
        if (last) {
          ctx.beginPath();
          ctx.moveTo(last[0], last[1]);
          ctx.lineTo(x, y);
          ctx.stroke();
        }
        last = [x, y];
      }
      const now = performance.now();
      if (now - lastBar > 40) {
        lastBar = now;
        this.updateBar();
      }
      if (this.samples.length >= this.target * 5) {
        this.finish();
      }
    };
    canvas.addEventListener("pointermove", onMove);
    // Drop the anchor when the pointer leaves so re-entering elsewhere does not
    // draw a long straight jump line across the canvas.
    canvas.addEventListener("pointerleave", () => {
      last = null;
    });

    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
  }

  private updateBar(): void {
    const pct = Math.min(100, Math.round((this.samples.length / (this.target * 5)) * 100));
    if (this.bar) {
      this.bar.style.width = `${pct}%`;
    }
    if (this.progressLabel) {
      this.progressLabel.setText(pct >= 100 ? "Done" : `Keep drawing… ${pct}%`);
    }
  }

  private finish(): void {
    // Serialize samples to bytes, then hash with fresh CSPRNG output for a
    // 256-bit key that depends on both sources.
    const buf = Buffer.from(Float64Array.from(this.samples).buffer);
    const digest = createHash("sha256").update(buf).update(randomBytes(32)).digest();
    this.settled = true;
    this.resolveValue(digest.toString("base64"));
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) {
      this.resolveValue(null);
    }
  }
}
