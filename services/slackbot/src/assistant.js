// ---------------------------------------------------------------------------
// Slack Assistant framework handler (assistant:write scope)
//
// Gives the bot a dedicated top-bar icon in Slack with:
// - Split-pane view (bot panel on the right, channels on the left)
// - Suggested prompts on first open
// - Loading states per tool execution
// - Thread titles auto-set from user query
// - Context awareness (which channel user is viewing)
//
// Requires: Enable "Agents & AI Apps" in Slack app settings and subscribe
// to assistant_thread_started + assistant_thread_context_changed events.
// ---------------------------------------------------------------------------

import { Assistant } from "@slack/bolt";

export function create_assistant({ handle_prompt_fn, logger }) {
  return new Assistant({
    threadStarted: async ({ say, setSuggestedPrompts, saveThreadContext }) => {
      await saveThreadContext();

      await say(
        "Hey! I can look up events, check payments, search Slack history, generate charts, and more. What do you need?"
      );

      await setSuggestedPrompts({
        prompts: [
          { title: "Upcoming events", message: "Show me upcoming events in the next 30 days" },
          { title: "Search Slack", message: "What was discussed about " },
          { title: "Ticket chart", message: "Generate a ticket sales chart for " },
          { title: "Check balance", message: "What's the artist payment balance for " }
        ]
      });
    },

    threadContextChanged: async ({ saveThreadContext }) => {
      await saveThreadContext();
    },

    userMessage: async ({ event, say, setTitle, setStatus, getThreadContext }) => {
      // getThreadContext and setStatus are independent — run in parallel
      const [thread_context] = await Promise.all([
        getThreadContext(),
        setStatus("Thinking...")
      ]);

      try {
        const response_text = await handle_prompt_fn({
          prompt_text: event.text,
          identity_context: {
            team_id: thread_context?.team_id || event.team,
            channel_id: event.channel,
            user_id: event.user,
            username: null
          },
          interaction_type: "assistant",
          set_status: setStatus
        });

        // say and setTitle are independent — run in parallel
        const title = event.text
          ? (event.text.length > 60 ? event.text.slice(0, 57) + "..." : event.text)
          : null;

        await Promise.all([
          say(response_text),
          title ? setTitle(title).catch(() => {}) : Promise.resolve()
        ]);
      } catch (error) {
        logger.error("assistant_handler_error", {
          error_message: error?.message,
          user: event.user
        });
        await say("Something went wrong processing your request. Please try again.");
      }
    }
  });
}
