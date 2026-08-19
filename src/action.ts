#!/usr/bin/env bun
/**
 * Plugin action dispatcher.
 *
 * Herdr runs actions detached, so stdout only reaches `herdr plugin log list`.
 * Anything the user needs to see goes through a notification instead.
 */

import { notify } from "./herdr.ts";
import { BIN } from "./config.ts";
import { resolveSelector, resolveTarget, addMessage, STATE_DIR } from "./store.ts";
import { openStrip, closeStrip, openPopup, syncIndicator, insertFirst } from "./ops.ts";
import { setup } from "./setup.ts";

interface Context {
  focused_pane_id?: string | null;
  focused_pane_agent?: string | null;
  selected_text?: string | null;
  clicked_url?: string | null;
}

const context: Context = (() => {
  try {
    return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}");
  } catch {
    return {};
  }
})();

const focusedPane = () => {
  const id = context.focused_pane_id || process.env.HERDR_ACTIVE_PANE_ID;
  if (!id) throw new Error("no focused pane in the action context");
  return id;
};

const action = process.argv[2] ?? "";

try {
  switch (action) {
    case "attach": {
      const paneId = focusedPane();
      const strip = await openStrip(paneId);
      await syncIndicator(await resolveTarget(paneId));
      console.log(`pinned ${strip} under ${paneId}`);
      break;
    }

    case "detach": {
      const paneId = focusedPane();
      console.log(`removed ${await closeStrip(paneId)}`);
      break;
    }

    case "open": {
      // A clicked pouch:// link wins over the focused pane, so a link printed
      // by `pouch add` reopens the pouch it actually landed in.
      const clicked = (context.clicked_url || process.env.HERDR_PLUGIN_CLICKED_URL || "").replace(/^pouch:\/\//, "");
      await openPopup(clicked ? await resolveSelector(clicked) : await resolveTarget(focusedPane()));
      break;
    }

    case "insert-top":
    case "insert-top-submit": {
      const submit = action === "insert-top-submit";
      const target = await resolveTarget(focusedPane());
      const outcome = await insertFirst(target, { submit });
      if ("reason" in outcome) {
        await notify("Pouch", outcome.reason);
        console.log(outcome.reason);
      } else {
        console.log(`inserted ${outcome.inserted.id} into ${target.paneId}${submit ? " and submitted" : ""}`);
      }
      break;
    }

    case "browse": {
      // No target: the picker is the point — it is the only surface that can
      // reach a pouch whose agent pane is gone.
      await openPopup(null, "browse");
      break;
    }

    case "compose": {
      await openPopup(await resolveTarget(focusedPane()), "compose");
      break;
    }

    case "stash-selection": {
      const text = (context.selected_text ?? "").trim();
      if (!text) throw new Error("nothing selected");
      const target = await resolveTarget(focusedPane());
      addMessage(target, text);
      await syncIndicator(target);
      await notify("Pouch", `Stashed ${text.length} chars for ${target.label}`);
      break;
    }

    // `install-cli` is the old name for the same thing, kept so an operator
    // following an older README still lands somewhere useful.
    case "setup":
    case "install-cli": {
      const steps = await setup();
      for (const step of steps) console.log(`${step.ok ? "ok" : "FAILED"}  ${step.what}: ${step.detail}`);
      const failed = steps.filter((step) => !step.ok);
      await notify(
        "Pouch",
        failed.length
          ? failed.map((step) => step.detail).join(" · ")
          : `Ready: \`${BIN}\` installed, prefix+shift+O opens the pouch`,
      );
      break;
    }

    case "doctor": {
      // Printed to `herdr plugin log list --plugin herdr.pouch`.
      console.log(
        JSON.stringify(
          {
            pluginRoot: process.env.HERDR_PLUGIN_ROOT,
            configDir: process.env.HERDR_PLUGIN_CONFIG_DIR,
            stateDir: process.env.HERDR_PLUGIN_STATE_DIR,
            socket: process.env.HERDR_SOCKET_PATH,
            resolvedStateDir: STATE_DIR,
            context,
          },
          null,
          2,
        ),
      );
      await notify("Pouch", "Wrote diagnostics to the plugin log");
      break;
    }

    default:
      throw new Error(`unknown action "${action}"`);
  }
} catch (err) {
  const message = (err as Error).message;
  console.error(`${BIN}: ${message}`);
  await notify("Pouch failed", message);
  process.exit(1);
}
