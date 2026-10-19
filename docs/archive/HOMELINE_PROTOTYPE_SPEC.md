> Historical reference. The current plan is in [the build spec](../MVP_BUILD_SPEC.md); current status is in [README](../../README.md).

# Homeline — MVP

**Product:** A household assistant that turns school messages and family updates into a confirmed plan for the next seven days.

**First user:** The parent who coordinates school-age children’s schedules, pickups, appointments, and household errands.

**Problem:** Information arrives in different places. One parent has to remember it, work out what needs doing, and make sure someone does it.

**Value:** Leave with dated events, assigned tasks, and a shopping list. Success means less coordination work and fewer missed commitments.

## Six pieces

- **Household memory:** Save family members and useful household context once; edit it when things change.
- **Update capture:** Paste a message or type an update. Optional browser dictation fills the same input.
- **Review:** Check proposed events, tasks, dates, and assignments before adding them. Keep the source attached.
- **Family plan:** View the next seven days, assign an adult, edit details, mark items done, and download the plan.
- **Shopping:** Add supplies and groceries, then check them off.
- **Optional weekly review:** See overlapping timed events, missing dates or owners, and past-due items. Resolve them or add a new update.

## Workflow

1. Add household members and useful context.
2. Paste or speak what changed.
3. Homeline proposes items; the parent confirms dates, timing, and responsibility.
4. Approved items enter the family plan and shopping list.
5. The parent marks work done or changes the plan.
6. The next review uses the saved plan and unresolved items.

**Example:** A field-trip update becomes a calendar event, a permission-slip task, and lunch supplies. The parent confirms the date and who handles each item.

## Rules

- Missing details stay unresolved; never invent a pickup arrangement or date.
- Flag actual overlapping times for the same adult or child. Travel time is not checked yet.
- Approval is required to add extracted items. Repeating approval cannot duplicate them.
- Completion means a parent marked an item done; it does not prove something happened outside Homeline.
- Check-ins are optional. No mandatory daily meeting.

## Current limits

- Phone-first interface with a Capacitor iOS project. The phone build stores one household on the device; the browser version retains its separate server database.
- Without a model key, guided mode creates one editable item per line. It does not understand a school email automatically.
- AI extraction is connected in the browser server but has not been tested with a live key. The iPhone build uses guided entry; cloud AI is not connected.
- Weekly review uses saved items and fixed rules; it is not a voice conversation with an AI.
- No inbox/calendar sync, recurring schedules, shared accounts, push reminders, iMessage, bookings, or purchases yet.

## Validate before expanding

Test whether parents return with real updates, finish a usable plan faster than their current method, and complete the resulting tasks. The payment hypothesis is saved coordination time; willingness to pay is unproven.
