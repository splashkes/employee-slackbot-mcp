// ---------------------------------------------------------------------------
// App Home tab builder — user-friendly guide with example questions
//
// Published via views.publish when a user opens the App Home tab.
// Tool count pulled from the manifest so it stays accurate automatically.
//
// Requires: Subscribe to app_home_opened event in Slack app settings.
// ---------------------------------------------------------------------------

export function build_home_blocks(allowed_tools_manifest) {
  const tool_count = allowed_tools_manifest?.tools?.length || 0;

  // Count domains
  const domains = new Set();
  for (const t of allowed_tools_manifest?.tools || []) {
    if (t.domain) domains.add(t.domain);
  }

  return [
    // ---- Hero ----
    {
      type: "header",
      text: { type: "plain_text", text: "Welcome to Arthur Bot", emoji: true }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Your AI operations assistant for Art Battle. Just ask me a question in plain English — I have access to *${tool_count} tools* and I'll figure out which ones to use.\n\nNo special syntax needed. Ask like you'd ask a coworker.`
      }
    },
    { type: "divider" },

    // ---- How to reach me ----
    {
      type: "header",
      text: { type: "plain_text", text: ":speech_balloon:  How to Talk to Me", emoji: true }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*In a channel* — `@Arthur Bot` followed by your question. I'll reply in a thread.\n\n*In a DM* — just message me directly, no @ needed.\n\n*Slash command* — type `/ab` followed by your question for a private response only you can see.\n\n*Assistant panel* — click my icon in the Slack sidebar for a dedicated chat panel."
      }
    },
    { type: "divider" },

    // ---- Events & Data ----
    {
      type: "header",
      text: { type: "plain_text", text: ":calendar:  Events & Data", emoji: true }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Look up any event, check auction results, find attendees, and review event health.\n\n" +
          ":small_blue_diamond: _\"Show me the details for AB4003\"_\n" +
          ":small_blue_diamond: _\"What events are coming up in Toronto?\"_\n" +
          ":small_blue_diamond: _\"How many bids were there at the last Sydney event?\"_\n" +
          ":small_blue_diamond: _\"Run a health check on AB4050\"_\n" +
          ":small_blue_diamond: _\"What was the auction revenue for AB4045?\"_\n" +
          ":small_blue_diamond: _\"Find the person who registered with the email jane@example.com\"_\n" +
          ":small_blue_diamond: _\"Look up the bid history for artwork 12345\"_"
      }
    },
    { type: "divider" },

    // ---- Artists & Profiles ----
    {
      type: "header",
      text: { type: "plain_text", text: ":art:  Artists & Profiles", emoji: true }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Search for artists, check invitations, update profiles, and find duplicates.\n\n" +
          ":small_blue_diamond: _\"Look up artist Maria Santos\"_\n" +
          ":small_blue_diamond: _\"Has Tyler Ball been invited to any upcoming events?\"_\n" +
          ":small_blue_diamond: _\"Check if there are duplicate profiles for Sarah Chen\"_\n" +
          ":small_blue_diamond: _\"What's the event readiness for AB4050?\"_\n" +
          ":small_blue_diamond: _\"Show me the QR scan status for AB4048\"_\n" +
          ":small_blue_diamond: _\"Update the artist bio for artist ID 5678\"_"
      }
    },
    { type: "divider" },

    // ---- Payments ----
    {
      type: "header",
      text: { type: "plain_text", text: ":money_with_wings:  Payments", emoji: true }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Check balances, review payment history, and manage payouts.\n\n" +
          ":small_blue_diamond: _\"What's the payment balance for artist Jane Smith?\"_\n" +
          ":small_blue_diamond: _\"Show me all artists who are owed money\"_\n" +
          ":small_blue_diamond: _\"What's the payment ledger for artist ID 1234?\"_\n" +
          ":small_blue_diamond: _\"Check the Stripe status for artist Maria Santos\"_\n" +
          ":small_blue_diamond: _\"Are there any pending manual payment requests?\"_\n" +
          ":small_blue_diamond: _\"What are today's exchange rates?\"_"
      }
    },
    { type: "divider" },

    // ---- Ticket Sales & Charts ----
    {
      type: "header",
      text: { type: "plain_text", text: ":chart_with_upwards_trend:  Ticket Sales & Charts", emoji: true }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Generate ticket sales pace charts, compare events, and set up automatic chart posting.\n\n" +
          ":small_blue_diamond: _\"Generate a ticket sales chart for AB4050\"_\n" +
          ":small_blue_diamond: _\"Show me how AB4050 compares to similar past events\"_\n" +
          ":small_blue_diamond: _\"Set up a daily chart autopost for AB4050 in this channel\"_\n" +
          ":small_blue_diamond: _\"What chart schedules are active right now?\"_\n" +
          ":small_blue_diamond: _\"Refresh the Eventbrite data for AB4050\"_"
      }
    },
    { type: "divider" },

    // ---- Marketing & Growth ----
    {
      type: "header",
      text: { type: "plain_text", text: ":mega:  Marketing & Growth", emoji: true }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Check ad campaigns, SMS audiences, offers, and sponsorships.\n\n" +
          ":small_blue_diamond: _\"Show me the Meta ads data for the last 7 days\"_\n" +
          ":small_blue_diamond: _\"How many people are in the SMS audience for Toronto?\"_\n" +
          ":small_blue_diamond: _\"What active offers are running right now?\"_\n" +
          ":small_blue_diamond: _\"Give me a sponsorship summary\"_"
      }
    },
    { type: "divider" },

    // ---- Slack Search ----
    {
      type: "header",
      text: { type: "plain_text", text: ":mag:  Search Slack History", emoji: true }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Search across historical Slack conversations to find past discussions.\n\n" +
          ":small_blue_diamond: _\"What was discussed about the venue change for Toronto?\"_\n" +
          ":small_blue_diamond: _\"Find Slack conversations about the new bidding system\"_\n" +
          ":small_blue_diamond: _\"What did the team say about the Sydney sponsorship deal?\"_"
      }
    },
    { type: "divider" },

    // ---- Platform & Bugs ----
    {
      type: "header",
      text: { type: "plain_text", text: ":wrench:  Platform & Troubleshooting", emoji: true }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Check system health, review errors, and file bug reports.\n\n" +
          ":small_blue_diamond: _\"Are there any recent bot errors?\"_\n" +
          ":small_blue_diamond: _\"Show me the email queue stats\"_\n" +
          ":small_blue_diamond: _\"File a bug report about the checkout not loading\"_\n" +
          ":small_blue_diamond: _\"What are the most-used tools this week?\"_"
      }
    },
    { type: "divider" },

    // ---- Tips ----
    {
      type: "header",
      text: { type: "plain_text", text: ":bulb:  Tips", emoji: true }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Ask follow-ups* — Reply in the same thread and I'll remember the context.\n\n" +
          "*Combine questions* — _\"Look up AB4050 and generate a ticket chart for it\"_ works.\n\n" +
          "*Be specific* — Event IDs (like AB4050) and names help me find the right data faster.\n\n" +
          "*Write actions need confirmation* — If I'm about to change something (update a name, process a payment), I'll ask you to confirm first with a button."
      }
    },
    { type: "divider" },

    // ---- Feedback ----
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*:sparkles: Give Feedback*\nReact to any of my messages with an emoji and I'll log it:\n\n:thumbsup: :heart: :fire: :tada:  —  helpful response\n:thumbsdown: :x: :confused:  —  something was wrong\n:bug: :wrench:  —  report a bug\n\nYou can also tell me directly: _\"File a bug report about...\"_"
      }
    }
  ];
}
