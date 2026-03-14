# The End of Workflow Trees: How Multimodal AI Is Rewriting Enterprise CX

**By Vasundra Srinivasan** — Author, *Data Engineering for Multimodal AI* (O'Reilly)

---

## The Workflow Problem Nobody Talks About

For the past decade, enterprise customer experience has been built on a lie: that customer intent can be fully captured in a decision tree.

Every major CX platform — from legacy IVR systems to modern chatbot builders — operates on the same fundamental assumption: design a workflow, map every possible customer path, and route accordingly. The result? Thousands of hand-crafted nodes, brittle integrations, and a maintenance nightmare that scales linearly with product complexity. When a customer goes "off-script," the system either loops, escalates, or fails silently.

In March 2026, Crescendo AI won Best of Enterprise Connect by doing something radical: they eliminated workflows entirely. Their multimodal AI platform lets customers speak, type, share images, and send documents within a single conversation — with no predefined decision trees governing the interaction. The AI reasons directly from the company's operational knowledge.

This article breaks down the architecture behind workflow-free multimodal CX, analyzes Crescendo's approach, and presents **Cortado** — an open-source implementation I built using Google's Agent Development Kit (ADK) and the Gemini Live API to demonstrate that this architecture is not only viable but buildable today.

---

## Why Workflows Break at Scale

Traditional CX workflows suffer from three structural problems.

**Combinatorial explosion.** A product with 50 features, 10 failure modes each, and 3 customer segments produces 1,500 potential conversation paths — before accounting for multi-issue contacts, language variants, or channel-specific behaviors. Maintaining these workflows becomes a full-time job for entire teams.

**Modal rigidity.** Workflows are designed for a single modality. Voice workflows route through IVR trees. Chat workflows follow text-based decision logic. When a customer wants to *describe* a problem verbally while *showing* a screenshot, traditional systems force a channel switch — losing context in the handoff.

**Brittle knowledge coupling.** Workflow nodes are tightly coupled to specific knowledge base articles or API calls. When product documentation changes, every affected node must be manually updated. The knowledge is not learned — it's hardcoded.

---

## The Crescendo Architecture: An Analysis

Crescendo's approach inverts the traditional model. Rather than encoding business logic into workflow trees, their system relies on three architectural pillars.

### 1. Direct Knowledge Grounding via MCP

Crescendo uses the Model Context Protocol (MCP) to give their AI assistants direct, real-time access to a company's source-of-truth systems — product catalogs, policy documents, order management systems. The AI does not consult a curated FAQ. It reads the same operational data that human agents use.

This eliminates the "knowledge base curation" step entirely. When a product's return policy changes in the source system, the AI's behavior changes immediately — no workflow update required.

### 2. Unified Multimodal Conversation

In Crescendo's system, voice, text, and visual inputs coexist within a single conversation session. A customer can begin speaking, pause to type a model number, share a photo of a damaged product, and resume speaking — all without the system treating these as separate interactions.

This is architecturally significant because it means the AI maintains a single, multimodal context window across the entire conversation. There is no "voice agent" handing off to a "chat agent" handing off to an "image classifier." It is one model, one context, one conversation.

### 3. Role-Specific Prompting Instead of Workflow Logic

Instead of workflow nodes that encode "if customer says X, do Y," Crescendo uses role-specific system prompts that define the AI's persona, boundaries, and objectives. The AI then *reasons* about how to help the customer, drawing on its grounded knowledge and the full multimodal context.

This is the most conceptually important shift: the intelligence moves from the *graph* (workflow) to the *model* (LLM reasoning). The workflow was always a proxy for intelligence. With sufficiently capable models and proper knowledge grounding, the proxy is no longer necessary.

---

## Cortado: An Open-Source Implementation

To validate this architecture, I built **Cortado** — a workflow-free multimodal support agent for Wahoo fitness products. Cortado can hear a customer describe a problem, see their hardware through a live camera feed, read uploaded screenshots, and resolve issues — all in a single, continuous conversation.

### The SOP Approach

Cortado's core insight is the same as Crescendo's: don't encode knowledge into the agent. Encode *operating procedures*.

A new hire at Wahoo's support team doesn't memorize every knowledge base article on day one. They get a training manual — a Standard Operating Procedure (SOP) — that tells them how to behave, when to escalate, and where to look for answers. Then they figure it out.

Cortado works identically. Its system prompt is a detailed Customer Support SOP covering:
- How to greet and identify the customer's product
- How to diagnose issues using all available modalities (what they say, what you can see, what they show you)
- When and how to search for technical answers
- Step-by-step resolution guidance procedures
- Escalation rules (when to direct to Wahoo's official support)
- Warranty policies and boundaries
- Behavioral guidelines (tone, honesty, safety)

The SOP is the *only designed artifact*. Everything else — product specifications, troubleshooting steps, firmware details, video tutorials — the agent finds in real time by searching the web.

### Technology Stack

| Component | Technology | Role |
|---|---|---|
| Agent Framework | Google ADK (Streaming) | Orchestrates the multimodal agent lifecycle |
| Real-Time I/O | Gemini Live API | Bidirectional audio/video streaming via WebSocket |
| Language Model | Gemini 2.5 Flash | Reasoning, conversation, multimodal understanding |
| Knowledge | Google Search | Real-time search of Wahoo support, YouTube, forums |
| Backend | FastAPI + WebSocket | Serves the streaming agent and handles client connections |
| Frontend | Responsive HTML/JS | Mobile-friendly UI with mic, camera, chat, and image upload |
| Deployment | Cloud Run + Cloud Build | Automated, containerized deployment on GCP |

### Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Client (Mobile Browser)                 │
│  ┌──────┐  ┌──────┐  ┌──────────┐  ┌───────────────┐    │
│  │ Mic  │  │ Cam  │  │ Text Box │  │ Image Upload  │    │
│  └──┬───┘  └──┬───┘  └────┬─────┘  └──────┬────────┘    │
│     └─────────┴───────────┴───────────────┘              │
│                        │ WebSocket                        │
└────────────────────────┼─────────────────────────────────┘
                         │
┌────────────────────────┼─────────────────────────────────┐
│  FastAPI Server        ▼                                  │
│  ┌─────────────────────────────────────┐                  │
│  │  ADK LiveRequestQueue               │                  │
│  │  (all modalities → single buffer)   │                  │
│  └──────────────┬──────────────────────┘                  │
│  ┌──────────────▼──────────────────────┐                  │
│  │  ADK Runner (session lifecycle)     │                  │
│  └──────────────┬──────────────────────┘                  │
│  ┌──────────────▼──────────────────────┐                  │
│  │  Cortado Agent                      │                  │
│  │  ┌──────────────────────────────┐   │                  │
│  │  │  Customer Support SOP        │   │                  │
│  │  │  (the ONLY designed artifact)│   │                  │
│  │  └──────────────────────────────┘   │                  │
│  │  ┌──────────────────────────────┐   │                  │
│  │  │  Tool: google_search         │   │                  │
│  │  │  (Wahoo site + YouTube +     │   │                  │
│  │  │   forums + app support)      │   │                  │
│  │  └──────────────────────────────┘   │                  │
│  └─────────────────────────────────────┘                  │
└──────────────────────────────────────────────────────────┘
```

### The Key Design Decisions

**SOP, not workflows.** The agent's behavior is governed by an operating procedure — not a decision tree. Change the SOP, change the agent. No graph to maintain, no nodes to update.

**Search, not RAG.** Why pre-embed and index content that's already on the web? The agent searches Wahoo's support site, YouTube channel, and community forums in real time — always current, zero ingestion pipeline, zero maintenance. This is what a human rep does: they look it up.

**Single context window.** Audio from the microphone, frames from the camera, typed text, and uploaded images all flow into the same `LiveRequestQueue`. The Gemini model sees everything in one context — exactly as a human support agent would.

**YouTube as knowledge.** Wahoo's YouTube channel (@wahoofitness) contains setup walkthroughs, troubleshooting videos, and product demos. The agent can search for and recommend specific videos — a modality that traditional text-based RAG systems completely miss.

---

## From Crescendo to Cortado: What Changes at the Open-Source Layer

Crescendo operates at enterprise scale with proprietary infrastructure. Cortado demonstrates the same *architectural principles* using entirely open and accessible tools.

| Crescendo (Enterprise) | Cortado (Open Source) |
|---|---|
| Proprietary LLM orchestration | Google ADK (open-source agent framework) |
| MCP integrations to enterprise systems | Google Search (real-time web access) |
| Custom SOP per client | Single SOP for Wahoo fitness support |
| Carrier-grade voice infrastructure | Gemini Live API (WebSocket-based) |
| Multi-tenant, multi-brand | Single-domain demo (Wahoo) |
| Production SLA guarantees | Prototype-grade, locally deployable |

The architectural DNA is the same: SOP-driven behavior, unified multimodal context, real-time knowledge access. The implementation layer is different — and that's the point. This architecture is not locked behind enterprise contracts. It's buildable today, by anyone, with public APIs.

---

## Implications for Enterprise CX

The shift from workflow-driven to SOP-driven multimodal AI has three major implications.

**Maintenance costs collapse.** Without workflow trees to maintain, the cost of updating AI behavior drops to two things: updating your SOP (a document) and updating your source documentation (which you're doing anyway). The AI adapts to doc changes automatically because it searches in real time.

**Channel convergence becomes real.** When voice, text, and vision coexist in one model context, "omnichannel" stops being a marketing term and becomes an architectural reality. There is no channel — there is only the conversation.

**The CX engineer's role changes.** Instead of designing workflow trees, CX teams will focus on writing great SOPs, defining guardrails, and monitoring agent behavior. The creative work shifts from "what should the bot say when..." to "how should the bot behave and where should it look for answers."

---

## Try It Yourself

Cortado is open-source and available at [github.com/cortado-ai](https://github.com/cortado-ai). It requires only a Gemini API key to run locally and demonstrates the full multimodal, workflow-free, SOP-driven architecture described in this article.

Built for the [Gemini Live Agent Challenge](https://geminiliveagentchallenge.devpost.com/) hackathon.

---

*Vasundra Srinivasan is the author of [Data Engineering for Multimodal AI](https://learning.oreilly.com/library/view/data-engineering-for/9781098190774/) (O'Reilly, 2025) and builds enterprise AI systems professionally. This article represents independent architectural analysis and is not affiliated with Crescendo AI.*
