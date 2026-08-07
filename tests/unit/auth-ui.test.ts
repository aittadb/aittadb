import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { authUiJs } from "../../src/pages";

interface FakeControl {
  value: string;
  disabled: boolean;
  required: boolean;
  dataset: Record<string, string>;
}

interface FakeEvent {
  preventDefault(): void;
}

class FakeConditionalField {
  readonly dataset: Record<string, string>;
  hidden = false;
  readonly attributes = new Map<string, string>();

  constructor(
    rule: string,
    private readonly controls: readonly FakeControl[],
  ) {
    this.dataset = { showWhen: rule };
  }

  querySelectorAll(): readonly FakeControl[] {
    return this.controls;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

class FakeForm {
  readonly dataset: Record<string, string>;
  readonly elements: { namedItem: (name: string) => FakeControl | null };
  private readonly listeners = new Map<
    string,
    Array<(event: FakeEvent) => void>
  >();
  private action: string;

  constructor(
    options: {
      controls?: Record<string, FakeControl>;
      fields?: readonly FakeConditionalField[];
      key?: FakeControl;
      action?: string;
      actionTemplate?: string;
    } = {},
  ) {
    const controls = options.controls ?? {};
    this.elements = { namedItem: (name) => controls[name] ?? null };
    this.fields = options.fields ?? [];
    this.key = options.key;
    this.action = options.action ?? "";
    this.dataset = options.actionTemplate
      ? {
          keyActionTemplate: options.actionTemplate,
          fallbackAction: this.action,
        }
      : {};
  }

  private readonly fields: readonly FakeConditionalField[];
  private readonly key: FakeControl | undefined;

  querySelectorAll(selector: string): readonly FakeConditionalField[] {
    return selector === "[data-show-when]" ? this.fields : [];
  }

  querySelector(selector: string): FakeControl | null {
    return selector === "[data-resource-key]" ? (this.key ?? null) : null;
  }

  addEventListener(name: string, listener: (event: FakeEvent) => void): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  dispatch(name: string, event: FakeEvent = { preventDefault() {} }): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  setAttribute(name: string, value: string): void {
    if (name === "action") this.action = value;
  }

  getAttribute(name: string): string | null {
    return name === "action" ? this.action : null;
  }

  actionValue(): string {
    return this.action;
  }
}

function control(value = ""): FakeControl {
  return { value, disabled: false, required: false, dataset: {} };
}

test("auth UI reveals only active fields and safely targets item URLs", () => {
  const authMode = control("session");
  const accessToken = control();
  accessToken.dataset.requiredWhenVisible = "true";
  const tokenField = new FakeConditionalField("auth_mode:token", [accessToken]);
  const conditionalForm = new FakeForm({
    controls: { auth_mode: authMode },
    fields: [tokenField],
  });

  const key = control("folder/hello world.txt");
  const navigationForm = new FakeForm({
    key,
    action: "/storage/files",
    actionTemplate: "/storage/files/{key}",
  });
  const document = {
    querySelectorAll(selector: string): readonly FakeForm[] {
      if (selector === "form[data-conditional-form]") return [conditionalForm];
      if (selector === "form[data-key-action-template]")
        return [navigationForm];
      return [];
    },
  };
  let assignedLocation = "";
  const window = {
    location: {
      assign(value: string): void {
        assignedLocation = value;
      },
    },
  };

  vm.runInNewContext(authUiJs(), { document, encodeURIComponent, window });

  assert.equal(tokenField.hidden, true);
  assert.equal(tokenField.attributes.get("aria-hidden"), "true");
  assert.equal(accessToken.disabled, true);
  assert.equal(accessToken.required, false);

  authMode.value = "token";
  conditionalForm.dispatch("change");
  assert.equal(tokenField.hidden, false);
  assert.equal(tokenField.attributes.has("aria-hidden"), false);
  assert.equal(accessToken.disabled, false);
  assert.equal(accessToken.required, true);
  assert.equal(conditionalForm.dataset.conditionalReady, "true");

  assert.equal(
    navigationForm.actionValue(),
    "/storage/files/folder/hello%20world.txt",
  );
  let navigationPrevented = false;
  navigationForm.dispatch("submit", {
    preventDefault(): void {
      navigationPrevented = true;
    },
  });
  assert.equal(navigationPrevented, true);
  assert.equal(assignedLocation, "/storage/files/folder/hello%20world.txt");

  key.disabled = false;
  key.value = "";
  navigationForm.dispatch("input");
  assert.equal(navigationForm.actionValue(), "/storage/files");
});
