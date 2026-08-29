#!/usr/bin/env node
/**
 * Send WhatsApp reminders for amendment deadlines.
 *
 * Runs straight after the sync, on the same schedule, so a letter that arrives
 * at nine is a message on a phone by noon at the latest.
 *
 *   npm run notify              # send, using WHATSAPP_TRANSPORT
 *   npm run notify -- --dry-run # print what would go out, send nothing
 *   npm run notify -- --test    # send one message now, to check the wiring
 *
 * Nothing configured means nothing is sent and the run still succeeds: a
 * tracker that fails its sync because a reminder service is missing would be a
 * poor trade.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { readRecipients, sendToAll } from "./lib/whatsapp.mjs";

import {
  DEFAULT_POLICY,
  dueReminders,
  composeFor,
  recordSent,
  reachedSomeone,
  pruneLedger,
  pendingDeadlines,
} from "./lib/notify.mjs";

import { describeDeadline } from "./lib/deadline.mjs";
import { syncIssues, commentReminder } from "./lib/issues.mjs";
import {
  postToChat,
  composeChat,
  chatConfigured,
} from "./lib/gchat.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const P = {
  manuscripts: path.join(ROOT, "data/manuscripts.json"),
  ledger: path.join(ROOT, "data/notifications.json"),
  policy: path.join(ROOT, "config/notify.json"),
};

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const testOnly = argv.includes("--test");

async function loadJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function main() {
  const registry = await loadJson(P.manuscripts, { manuscripts: [] });
  const ledger = await loadJson(P.ledger, { sent: [] });
  const configured = await loadJson(P.policy, {});
  const policy = { ...DEFAULT_POLICY, ...configured };

  const transport =
    dryRun
      ? "console"
      : (process.env.WHATSAPP_TRANSPORT || "").trim() || "console";

  let recipients;

  try {
    recipients = readRecipients();
  } catch (err) {
    console.error(
      `WhatsApp reminders are misconfigured: ${err.message}`
    );
    recipients = [];
  }

  if (!recipients.length && !testOnly) {
    console.log(
      "No WhatsApp recipients configured (WHATSAPP_RECIPIENTS is unset), so no messages will be sent.\n" +
      "The deadline issues below still are. See the README section " +
      "\"Deadline reminders on WhatsApp\" to turn messaging on."
    );
  }

  /*
   * TEST MODE
   *
   * Sends exactly one test message and does not touch the reminder ledger.
   */
  if (testOnly) {
    if (!recipients.length) {
      console.error(
        "Nobody to send a test to: WHATSAPP_RECIPIENTS is unset."
      );
      process.exitCode = 1;
      return;
    }

    const text =
      "✅ ORG Karur COMMS is wired up.\n\n" +
      "This is a one-off test. Real messages arrive when a journal returns a " +
      "manuscript for amendments, and again as the deadline approaches.";

    const results = await sendToAll(
      recipients,
      text,
      {
        transport,
        pauseMs: 2000,
      }
    );

    report(results);

    process.exitCode =
      results.length > 0 && results.every((r) => r.ok)
        ? 0
        : 1;

    return;
  }

  /*
   * ALWAYS PRINT THE CURRENT DEADLINE PICTURE
   */
  const pending = pendingDeadlines(registry, { policy });

  console.log(
    `${pending.length} manuscript(s) on a deadline:`
  );

  for (const { manuscript, left } of pending) {
    const source =
      manuscript.deadlineSource === "assumed"
        ? " [estimated]"
        : "";

    console.log(
      `  ${describeDeadline(manuscript.deadline).padEnd(16)} ` +
      `${(manuscript.currentJournal || "?")
        .slice(0, 34)
        .padEnd(34)} ` +
      `${manuscript.title.slice(0, 50)}${source}`
    );
  }

  /*
   * GITHUB ISSUES
   *
   * Issues are independent of WhatsApp.
   */
  const issueToken = process.env.GITHUB_TOKEN || "";
  const repo = process.env.GITHUB_REPOSITORY || "";

  let issues = {
    opened: [],
    updated: [],
    closed: [],
  };

  if (policy.githubIssues !== false) {
    try {
      issues = await syncIssues(
        pending,
        ledger,
        {
          token: dryRun ? "" : issueToken,
          repo,
          dashboardUrl: policy.dashboardUrl || "",
        }
      );

      if (issues.skipped) {
        console.log(`\nIssues: ${issues.skipped}`);
      } else {
        for (const i of issues.opened) {
          console.log(
            `\nOpened issue #${i.number}: ${i.title}`
          );
        }

        for (const i of issues.updated) {
          console.log(
            `Updated issue #${i.number}: ${i.title}`
          );
        }

        for (const i of issues.closed) {
          console.log(
            `Closed issue #${i.number}: ${i.title}`
          );
        }

        if (
          !issues.opened.length &&
          !issues.updated.length &&
          !issues.closed.length
        ) {
          console.log("\nIssues already up to date.");
        }
      }
    } catch (err) {
      /*
       * GitHub issue failures must never prevent WhatsApp attempts.
       */
      console.error(
        `Could not update the deadline issues: ${err.message}`
      );
    }
  }

  /*
   * DETERMINE WHICH REMINDERS ARE DUE
   */
  const due = dueReminders(
    registry,
    ledger,
    { policy }
  );

  if (!due.length) {
    console.log("\nNo reminders due.");
    await saveLedger();
    return;
  }

  const chatWebhook =
    (process.env.GCHAT_WEBHOOK_URL || "").trim();

  if (!chatConfigured()) {
    console.log(
      "\nGoogle Chat is not configured (GCHAT_WEBHOOK_URL is unset)."
    );
  }

  console.log(
    `\n${due.length} reminder(s) due:`
  );

  let sentCount = 0;

  /*
   * PROCESS EACH REMINDER INDEPENDENTLY
   */
  for (const reminder of due) {
    const message = composeFor(
      reminder,
      {
        dashboardUrl:
          policy.dashboardUrl || "",
      }
    );

    /*
     * WHATSAPP
     *
     * This is the ONLY channel that can mark the WhatsApp reminder
     * as successfully delivered.
     */
    const results = recipients.length
      ? await sendToAll(
          recipients,
          message,
          {
            transport,
            pauseMs: 2000,
          }
        )
      : [];

    report(
      results,
      `${reminder.kind} · ${reminder.manuscript.title.slice(0, 50)}`
    );

    /*
     * DRY RUN
     *
     * Do not send, comment, post, or modify the ledger.
     */
    if (dryRun) {
      continue;
    }

    /*
     * GOOGLE CHAT
     *
     * This is an independent notification channel.
     * It does NOT count as WhatsApp delivery.
     */
    let posted = false;

    if (chatWebhook) {
      try {
        await postToChat(
          composeChat(
            reminder,
            {
              dashboardUrl:
                policy.dashboardUrl || "",
            }
          ),
          {
            webhook: chatWebhook,
            threadKey:
              `manuscript-${reminder.manuscript.id}`,
          }
        );

        posted = true;

        console.log(
          "  ✓ posted to Google Chat"
        );
      } catch (err) {
        console.error(
          `  ✗ Google Chat: ${err.message}`
        );
      }
    }

    /*
     * GITHUB ISSUE COMMENT
     *
     * Also independent from WhatsApp.
     * A successful issue comment must NOT consume the WhatsApp reminder.
     */
    let commented = false;

    try {
      const number = await commentReminder(
        reminder,
        ledger,
        {
          token: issueToken,
          repo,
        }
      );

      if (number) {
        commented = true;

        console.log(
          `  ✓ commented on issue #${number}`
        );
      }
    } catch (err) {
      console.error(
        `  ✗ could not comment on the issue: ${err.message}`
      );
    }

    /*
     * IMPORTANT DELIVERY RULE
     *
     * Only successful WhatsApp delivery records the reminder as sent.
     *
     * Google Chat and GitHub comments are deliberately NOT included here.
     * Otherwise a GitHub/Chat success could suppress a WhatsApp reminder
     * that never actually reached the phone.
     */
    if (reachedSomeone(results)) {
      recordSent(
        ledger,
        reminder,
        results
      );

      sentCount++;

      console.log(
        "  ✓ WhatsApp delivery recorded"
      );
    } else {
      console.log(
        "  ! WhatsApp did not succeed; " +
        "reminder will be retried on the next run."
      );
    }
  }

  /*
   * SAVE LEDGER
   */
  if (dryRun) {
    console.log(
      "\nDry run — nothing was sent and nothing was recorded."
    );
    return;
  }

  await saveLedger();

  if (sentCount) {
    console.log(
      `\nRecorded ${sentCount} reminder(s) as sent.`
    );
  } else {
    console.log(
      "\nNo WhatsApp reminders were successfully delivered."
    );
  }

  async function saveLedger() {
    if (dryRun) return;

    await writeFile(
      P.ledger,
      `${JSON.stringify(
        pruneLedger(ledger),
        null,
        2
      )}\n`
    );
  }
}

/*
 * Print per-recipient results without exposing phone numbers or API keys.
 */
function report(results, label = "") {
  for (const r of results) {
    const mark = r.ok ? "✓" : "✗";

    console.log(
      `  ${mark} ${r.name}` +
      `${label ? ` — ${label}` : ""}` +
      `${r.ok ? "" : `: ${r.error}`}`
    );
  }
}

main().catch((err) => {
  /*
   * Never take the sync down with it.
   */
  console.error(err);
  process.exitCode = 1;
});
