> Historical reference. The current plan is in [the build spec](../MVP_BUILD_SPEC.md); current status is in [README](../../README.md).

# Wren: choosing a meeting-preparation product

Research date: September 22, 2026. Product recommendations below are hypotheses to test, not a committed change to the MVP.

## Recommendation

Test Wren with **owners of small design and web-development agencies who need to discuss additional work with an existing client**. Start with one situation: the client wants something the owner believes is outside the agreed scope, and the owner wants to protect the relationship while agreeing on price, timing, or a tradeoff.

Proposed pitch: **Wren helps agency owners prepare for difficult scope conversations, using the original agreement and client messages to work out what to say, practice pushback, and confirm the next step.**

The strongest alternative is first-time managers preparing an initial corrective-feedback conversation with a direct report. That has clearer demand for emotional support, but more direct coaching competition and a less immediate financial outcome.

My confidence is moderate that these problems deserve testing, and low that either supports a subscription without further evidence. Public complaints establish pain. Competitor prices establish offers. Neither establishes that people will pay Wren.

## What the research supports

This review used public Reddit discussions in managers, agency, freelance, and CustomerSuccess communities; Hacker News; public LinkedIn posts; official product and pricing pages; leadership guidance; survey reports; and research papers. It is qualitative desk research, not a representative market survey or a customer-interview study. Products were researched from their published material, not tested hands-on.

I gave greater weight to specific accounts of an actual incident than to questions such as “would you use my tool?” Forum identities and experiences cannot be independently verified. Recent AI-tool discussions contain substantial promotion. LinkedIn vendor posts were useful for understanding positioning, not independent demand. No private communities or private user data were accessed.

### 1. People often know the facts and still struggle to act

A video producer described a client requesting two additional cuts after agreeing to one deliverable. The producer had the contract and email history; the difficulty was pushing back while keeping a repeat client. This is an unusually close match to Wren: evidence alone had not resolved the conversation. [Firsthand agency discussion](https://www.reddit.com/r/agency/comments/1ffvotb/how_do_i_prevent_scope_creep_in_the_revision/)

An older agency discussion describes delayed projects restarting with changed expectations, extra unpaid work, and stress on both sides. This predates the current AI-tool promotion wave and supports the persistence of the problem, although it remains anecdotal. [Fixed-budget project discussion](https://www.reddit.com/r/agency/comments/r1glyg/how_do_you_prevent_scope_creep_in_a_fixed_budget/)

For managers, one poster described being articulate in other settings but stumbling when delivering feedback to an employee who debates their points. They specifically welcomed practicing the opening sentences. The need was handling a reaction, not obtaining a biography or writing a longer agenda. [Manager account](https://www.reddit.com/r/managers/comments/1u7w68t/struggling_to_deliver_feedback_to_a_difficult/)

**Product implication:** prepare the decision and the difficult exchange. An attendee summary is secondary.

### 2. Context collection can be more work than the meeting brief

A customer-success professional described preparing shortly before calls by feeding a previous transcript and follow-up email into ChatGPT, then reviewing usage data. Another thread describes escalation history scattered across Teams, email, Slack, and CRM records. These are two different problems: reconstructing the account and deciding how to speak with the customer. [CSM account](https://www.reddit.com/r/CustomerSuccess/comments/1wjlq3a/im_leaving_customer_success_after_8_years_a/), [escalation tracking discussion](https://www.reddit.com/r/CustomerSuccess/comments/1vwfq3e/question_on_escalations/)

**Product implication:** customer-success escalation prep may be valuable, but it is a harder first build. Good advice can depend on usage, unresolved incidents, promises, commercial terms, and authority to offer remedies. A small agency scope discussion often starts with fewer documents. That comparison is an inference to validate with actual cases.

### 3. There is financial pain, but its cause is broader than communication

Ignition's May 2025 survey of 273 US agency managers and executives reports that 57% lose $1,000 to $5,000 monthly to unbilled scope work; 78% rarely or only sometimes charge for work outside scope. These are self-reported results from a vendor selling billing software. The public release does not provide enough sampling detail to treat them as representative of every agency. They do establish a plausible economic problem to investigate. [Original survey release](https://www.ignitionapp.com/news/2025-agency-pricing-cashflow-report)

A counterexample matters: some agency participants deliberately absorb small requests because margins and retention justify it. A client-side commenter described being surprised by an agency's complaints about overservicing when they believed they were following the agreed process. [Absorbing extras](https://www.reddit.com/r/agencynewbies/comments/1wbfnww/how_do_you_guys_handle_scope_creep/), [client-side perspective](https://www.reddit.com/r/marketingagency/comments/1rbpdqi/scope_creep_how_do_you_deal_with_it_when_clients/)

**Product implication:** Wren should help choose whether to charge, swap, defer, or consciously absorb work. Automatically siding with the agency would produce bad advice. Missing approvals, poor estimates, or genuinely ambiguous scope can require a process fix rather than a better script.

### 4. Voice rehearsal has promise, but more conversation is not always better

A research prototype, Trucey, was compared with ChatGPT and a negotiation handbook in an experiment with 267 participants, followed by 15 interviews. Trucey reduced fear most, while the handbook performed better on usability and psychological empowerment. Participants found some AI guidance fragmented and verbose. The study did not place participants in actual negotiations, so it does not establish improved real-world results. [Paper and limitations](https://arxiv.org/html/2509.22545v1)

A separate qualitative study of AI roleplay for managers reports interest in adaptive practice, context-aware feedback, and control over simulated personas. It examines perceptions, not demonstrated workplace performance or willingness to pay. [CommCoach paper](https://arxiv.org/abs/2505.14452)

In a builder-started Reddit thread, responses included both interest in practice and skepticism that it can reproduce the emotional weight of a real conversation. I treat this as useful objection discovery, not organic product demand. [Mixed reactions](https://www.reddit.com/r/managers/comments/1vf33vi/what_actually_helped_you_prep_for_hard/)

**Product implication:** give users a compact plan they can reread, then offer targeted practice. Measure whether they handle the real conversation better, not just whether the simulation feels impressive.

## Which meetings are worth targeting?

These rankings are product judgments from the sources above and below, not measured market scores. Frequency and purchasing assumptions need interviews.

| Meeting situation | User and likely buyer | Context needed | Commercial case | Main weakness | Decision |
|---|---|---|---|---|---|
| Additional scope or revisions with an existing client | Agency owner; often also buyer | Agreement, new request, prior promises, effort and timing | Can connect to approved paid work or avoided unpaid work | Better change-control software may solve more of the problem | First paid test |
| Initial corrective-feedback conversation | First-time manager; self-funded or employer | Specific incident, expected standard, earlier feedback, available support | Coaching and training budgets exist | Crowded; sensitive context; recurring paid use unproven | Strong alternative |
| At-risk renewal or customer escalation | CSM; head of CS buys | Account history, usage, support, commitments, commercial authority | Revenue at risk | Integration and organizational dependencies | Later B2B option |
| Salary or promotion negotiation | Employee buys | Achievements, compensation evidence, alternatives, decision process | Personal financial stakes | Episodic; specialist expertise matters | Better suited to a paid session |
| Routine internal status meeting | Employee or team | Recent updates and open tasks | Time saved | Briefing and note products already cover much of it | Weak starting point |
| Social or relationship conflict | Individual buys | Personal history, boundaries, other person's perspective | Strong emotional need | Outcomes and repeat value harder to define | Defer |

For manager training, Gallup's 2025 report says 44% of managers globally reported receiving management training. That supports a training gap, but does not tell us how many want an AI coach or would personally buy one. [Gallup report](https://www.gallup.com/file/workplace/659528/state-of-the-global-workplace-2025-download.pdf)

Salary-coaching discussions include people evaluating paid services and complaints about service quality. These support the existence of a buying decision, not a general endorsement of the category. [User discussion](https://www.reddit.com/r/cscareerquestions/comments/s4yaqw)

## Competition and the standard Wren must beat

Published offers checked September 22, 2026. Listed prices are not verified sales or retention data.

| Product or substitute | Published capability / offer | Implication for Wren |
|---|---|---|
| [Yoodli](https://yoodli.ai/pricing) | Individual roleplay; Pro $8/month and Advanced $20/month, billed annually; custom team pricing | Voice roleplay alone has a low-priced substitute |
| [Nerve](https://www.nerveapp.io/) | Difficult-conversation practice, coaching, conversation guides; $59/month Pro listed | Almost the exact broad difficult-conversation proposition already exists |
| [Jodie](https://myjodie.com/) | Manager guidance and difficult-conversation support; $100/month individual plan | Manager-specific positioning alone is insufficient |
| [Valence / Nadia](https://www.valence.co/ai-and-the-workforce/ai-coaching-in-2025) | Describes personalized coaching, memory, voice/text, and proactive accountability | Personalization and follow-up are already competitor claims |
| [Kona by 15Five](https://www.15five.com/products/kona) | Meeting support and coaching informed by performance and engagement data | Established HR products have access to context a standalone tool lacks |
| [Granola](https://www.granola.ai/blog/daily-weekly-briefing-from-meetings) | Meeting-history queries and reusable briefing recipes, including day preparation | Generic recap and agenda generation face strong substitutes |
| [Docket](https://scopedocket.com/) | Scope requests, budget/timeline impact, client approval, project log; free tier, $79/month Pro | A process tool may outperform coaching for scope problems |
| [Ignition](https://www.ignitionapp.com/client-management-software) | Proposals, billing and payment workflows | Agencies may prefer spending on the commercial workflow itself |
| General AI plus a template, mentor, or colleague | Forum users already describe AI drafting and preparation | Wren must outperform an inexpensive existing habit |

The general-AI substitute is visible in [manager discussions](https://www.reddit.com/r/managers/comments/1ne208x/any_managers_here_using_ai_to_make_life_easier/). Complaints about context-free AI output also appear in [this thread](https://www.reddit.com/r/managers/comments/1kh6om0/). These are mixed experiences, not a controlled product comparison.

Wren's proposed distinction is the complete handling of one real situation: reconstruct the agreement, identify uncertainty, choose acceptable options, practice the difficult response, and capture the actual outcome. None of these ingredients is unique. Their usefulness and convenience together must earn the purchase.

## What information actually matters?

The meeting title tells us when to help. It rarely tells us enough about what to say. For the proposed first workflow, Wren needs this small case record:

| Information | Why it changes preparation | Lightweight source |
|---|---|---|
| What happened and what prompted the conversation | Establishes the issue to resolve | Recent message or short voice note |
| What was agreed | Separates a new request from existing obligations | Relevant proposal or statement-of-work excerpt |
| What each side believes was agreed | Reveals ambiguity before confrontation | User account plus client's actual wording |
| Desired result | Determines the ask | One direct question |
| Acceptable alternatives | Prevents improvising concessions under pressure | User supplies price, timing, swaps, or limits |
| Previous promises and exceptions | Changes whether pushback is fair or credible | Earlier message, note, or user confirmation |
| Who can approve a change | Determines whether the meeting can produce a decision | User knowledge; confirm if uncertain |
| What the user fears hearing | Defines the useful rehearsal | User's own description |
| Relationship and business importance | Affects the willingness to compromise | Optional short explanation |

For corrective feedback, replace the agreement and scope fields with the communicated expectation, observable incident, impact, employee's account, earlier support, and achievable next step. CCL's feedback guidance distinguishes observed behavior and impact from assumptions about intent. Harvard's negotiation guidance recommends describing a disagreement from a perspective both parties can recognize. These support the preparation structure; they do not validate Wren's effectiveness. [CCL](https://www.ccl.org/articles/leading-effectively-articles/closing-the-gap-between-intent-vs-impact-sbii/), [Harvard PON](https://www.pon.harvard.edu/daily/mediation/think-like-a-mediator/)

A person's job title or public profile usually matters less here than their decision authority, previous commitments, and the specific disagreement. Avoid inferring personality or motives from profiles.

## Getting context without integrations

Proposed flow, with timing treated as a design target:

1. **The user texts the situation or sends a 60-second voice note.** “Client wants two more pages before Friday. I need to discuss the extra cost.”
2. **Wren asks for one useful artifact.** “Send the scope paragraph and their latest request. You can remove names.” A pasted excerpt or screenshot should be sufficient to start.
3. **Wren asks only questions that change the advice.** Usually the desired outcome, any prior promise to include the work, and acceptable price/timing alternatives. Stop once a provisional plan is possible.
4. **Wren reflects the interpretation back.** “You want to keep Friday's delivery, but the new pages need an added fee or a later date. Did I get that right?”
5. **The user chooses a short plan, rehearsal, or both.** A longer information-gathering session must earn its time.

Every relevant claim should carry a source and status: document-backed, reported by the user, inferred, or unknown. A screenshot may omit an earlier promise. A voice note contains one side's recollection. OCR can misread an amount. Confirm consequential details before using them in an opening or a follow-up draft.

When the purpose is unknown, ask what triggered the invite or help the user draft a short question to the organizer. Do not invent a hidden agenda. If the user cannot provide documents, offer conditional preparation: “If the additional pages were excluded, discuss a change; if the wording is ambiguous, begin by comparing expectations.”

After a meeting, ask for a brief debrief: what was agreed, by whom, and by when. User-confirmed outcomes can improve the next preparation. Previous AI guesses must never become remembered facts.

For the initial test, pasted text and voice notes are enough. File upload can use a small secure web page. Calendar access is optional. Broader email and project integrations should follow evidence that manual context entry is preventing repeat use. Messaging can be the main interface while documents and privacy controls remain accessible through links.

## What the user gets before the meeting

Keep the first plan to roughly one phone screen, with details available underneath:

- The outcome to seek and any unresolved assumption.
- The few facts that support the discussion, linked to their source.
- An opening in the user's normal language.
- One question that could reveal missing context.
- Two or three acceptable options, using user-approved numbers.
- A response to the objection the user is most worried about.
- The decision and next step to confirm at the end.

**Illustrative example, not a research observation:** A web agency has an agreement listing five pages. The client requests two more. The owner confirms an estimate of $800 and three extra working days; the deadline is important.

Wren might flag: “The agreement lists five pages, but we haven't checked whether you promised the extra pages elsewhere.” After confirmation, an opening could be: “The two new pages change the work needed for launch. Let's decide whether to add them with more time and budget, or keep this release to the original five.”

The useful question may be: “What needs to happen on launch day that makes those pages important?” The answer could reveal a smaller solution. Practice the client's possible “I thought this was included” response, while making clear that it is a scenario, not a prediction.

Afterward, draft a confirmation from the actual agreement reached. Never convert a rehearsal outcome into a record of the real meeting.

## Emotionally charged conversations

Preparation needs to account for the user's reactions as well as the other person's possible responses. Ask what they tend to do under pressure: over-explain, agree too quickly, become accusatory, or avoid stating the request. Treat the answer as self-report, not a diagnosis.

Offer a short rehearsal around one difficult moment. The simulated client can challenge an assumption, reject a price, or disclose a constraint. It should sometimes have a legitimate objection. A tool that always validates the user can make the real conversation worse.

Feedback should cite a specific exchange: “You agreed to Friday before checking the extra work,” or “You explained the new fee but never asked whether they could approve it.” A general confidence score cannot establish readiness.

Let the user control the difficulty and pause the exercise. Build a plan for disagreement, including when to gather evidence or involve the person with decision authority. For the first product, keep legal disputes, formal disciplinary decisions, harassment investigations, and crisis situations outside the supported workflow. Those require expertise and processes beyond this proposed preparation tool.

## What users might pay for

The agency buyer's proposed value is a clearer commercial agreement reached sooner, with less avoidable unpaid work. The manager buyer's proposed value is timely, specific feedback delivered with less avoidance and better follow-through. These are outcomes to measure, not results we can currently promise.

Test **$25 for preparation for one live scope conversation, including a debrief**. Offer **$49/month for a limited repeat-use pilot** only to users who return with another case. These are experimental prices, not estimates derived from the market. Track model, voice, messaging, support, and human-review costs before choosing a permanent plan.

Do not attribute an entire project or retained client to Wren. Track concrete results: an approved added fee, an explicit reduction in deliverables, a revised date, or a documented decision to absorb the work. Even these need user confirmation and cannot prove causality on their own.

The primary commercial risk is that owners prefer a reusable email template or approval tool, and find rehearsal unnecessary. Another is low frequency: a useful occasional service may not justify a monthly subscription. The paid test should be allowed to discover either.

## Validation before building more

**Recruit for an actual upcoming situation.** Start with ten owners of design/web agencies, provisionally two to fifteen people, who have a scope discussion expected within two weeks. The size range is a recruiting hypothesis. Interview five first-time managers as a comparison group, but run one product pilot at a time.

Ask for a recent case before showing Wren:

- What triggered the conversation, and what did you actually do to prepare?
- Can you show a redacted message or agreement that mattered?
- What did you avoid saying? What happened as a result?
- How often has this happened in the last two months?
- Did you ask someone for help, use AI, or buy any service?
- What would make sharing even a redacted version unacceptable?

Then offer the paid preparation for the upcoming meeting. A promise to pay later is weaker evidence than a purchase. Do not manufacture urgency or claim unproven results.

For the pilot, use human-reviewed plans and identify that involvement to participants. Compare Wren with a one-page preparation worksheet; where practical, also compare a general AI assistant using the same inputs. Avoid giving Wren better source material and then attributing the advantage to the product.

Suggested decision gates, chosen for this pilot rather than claimed as industry benchmarks:

| Question | Initial signal to seek |
|---|---|
| Can users provide enough context? | At least 7 of 10 complete intake within five minutes without broad integrations |
| Will they pay? | At least 4 of 10 buy a $25 live-case session |
| Does Wren change preparation? | Users identify a concrete changed decision, question, or response; assess against the worksheet |
| Is rehearsal needed? | Users choose it and can identify a useful correction afterward |
| Is there repeat demand? | At least 3 return with a second real case within 30 days; count how many had another eligible event |
| Is advice grounded? | Every price and commitment is traceable; unsupported consequential claims are corrected before delivery |

With ten participants these are directional gates, not statistically reliable conversion estimates. Track how participants were recruited, especially personal contacts. If users pay once but rarely face a second case, test per-session pricing. If they mainly need scope tracking, reconsider the product around change approval. If managers show stronger paid repeat use, revisit that segment with a more specific feedback workflow.

## Implications for the existing Wren scaffold

Keep the messaging architecture and choose one workflow only after the pilot. The next useful additions would be a case record with source references, targeted clarification, a compact preparation plan, optional rehearsal, and a user-confirmed debrief.

Background work should have a concrete trigger: new context arrives, an agreed preparation time approaches, or the user requests a follow-up. Constant generation without new evidence offers no demonstrated benefit here. A useful proactive message is “You have the client call tomorrow; did you confirm who can approve the added cost?” Its value comes from an unresolved question tied to an actual event.

Defer broad social advice, browsing people's profiles, autonomous client outreach, and a large tool catalog. First establish that Wren helps a specific person handle a specific conversation well enough to buy it again.

## Evidence cautions

- Several sources repeat the same Ignition survey. They are one evidence base, not multiple independent confirmations. One third-party summary differed on a late-payment figure; this report uses only the original release for quoted survey numbers.
- The manager preparation thread asking for a cheat sheet included promotional replies. It was inspected but is not relied on as proof of paid demand.
- A builder explicitly started the manager roleplay thread. Its skeptical responses are useful; its existence is not demand.
- Public pricing from Nerve, Jodie, and Docket proves an offer is advertised, not that it sells. No customer counts or revenue were verified.
- No source reviewed establishes that this proposed Wren workflow improves paid scope approval, client retention, or employee outcomes. That is what the pilot must investigate.
