# Spanish naming directions

**Superseded exploration:** the current brief is [Brand and motion](../../docs/BRAND-AND-MOTION-BRIEF.md). It requires a software-oriented name, restrained personality, and an animated evolution of the existing Clawd identity. The recommendations below were not selected and should not drive implementation.

Working proposals, 2026-09-16. No application rename has been applied.

The product is becoming a Windows companion for multiple AI providers. Its name should describe our own personality and purpose, with Claude, Codex, and future providers appearing as integrations.

## Current direction: an animal with a secret-agent personality

For the requested Spanish or Mexican animal and television-agent direction, my finalists are **Tlacu** and **Cleto**. These take priority over the word-based alternatives below.

| Proposed name | Inspiration | Personality and visual concept |
| --- | --- | --- |
| **Tlacu** | A shortening of tlacuache | A small nocturnal lookout with an earpiece and a curled tail; cheeky, observant, memorable |
| **Cleto** | A playful shortening of Anacleto | An old-school agent name with dry humor; works as the name of an original animal character too |
| **Don Tejón** | A badger given a Spanish character name | A slightly grumpy, dependable supervisor with natural facial stripes and a tiny tie |
| **Chapu** | A nod to Chapulín | Lively, helpful, optimistic; an original grasshopper character that springs to attention |

**Product recommendation: Tlacu.** Use “Agente Tlacu” as the mascot's personality and **“Tus agentes, a la vista.”** as the explanatory line. A small character can peek over the floating bar, raise an ear when input is needed, and rest when nothing requires attention. Those are design proposals, not biological behaviors. Keep the icon readable at tray size and provide static reduced-motion states.

**Best alternative: Cleto.** It has the clearest secret-agent association and makes natural copy: “Cleto te avisa.” The name does not lock the product to an animal, provider, or Windows surface.

The animal reference is grounded in Mexico's [SEDEMA mammal guide](https://proyectos.sedema.cdmx.gob.mx/mamiferos/listado.html), which describes the northern tlacuache as nocturnal. For cultural references, [Anacleto on RTVE](https://www.rtve.es/play/videos/somos-cine/anacleto-agente-secreto/5720011/) supplies the Spanish secret-agent connection, and [Chespirito's official timeline](https://chespirito.com/linea-de-tiempo/) documents the Chapulín television character. Mortadelo and Filemón are another useful reference for comic agent personalities, documented by [their publisher's educational material](https://penguinaula.com/es/wp-content/uploads/2025/11/EXPO-Francisco-Ibanez-maestro.pdf). Anacleto and Mortadelo/Filemón began in comics; Chapulín is a television superhero rather than a secret agent.

Use these as personality references while designing an original mascot and visual identity. The proposed names remain candidates, not a decision to rename the app.

### Additional collision findings

- **Lince:** [LINCE](https://lince.sh/) already manages multiple coding agents, including Claude and Codex. This is a close product collision, so exclude it.
- **Cacomi:** [Cacomi](https://cacomi-app.com/) already scans source code and app binaries. Exclude it from the preferred developer-tool shortlist.
- **Mixtle:** already names a [word game](https://mixtle.net/) and a [cacomixtle university mascot](https://www.iedep.edu.mx/docs/gaceta/gaceta.pdf). Do not present that mascot concept as unique.
- **Tlacu:** a [Tlacu Theme](https://marketplace.visualstudio.com/items?itemName=AxelAgabo.tlacu-theme) for VS Code already uses the animal-inspired name. This is a visible use to investigate before choosing the public name; no availability claim is made.

## Alternative word-based direction: Follón

**Follón** is the strongest of the word-based options for a fun, Spanish, slightly edgy personality. It evokes the mess of running several agents at once and makes that chaos feel manageable. It is short, expressive, and independent of any provider.

**Main line:** Todo tu follón de agentes, bajo control.

**Shorter line:** Tus agentes. Bajo control.

Use `Follón` in the wordmark and `follon` in technical identifiers if the name is selected. The accent adds character but requires an ASCII form for commands and package names. The main tradeoff is deliberate: a name associated with commotion needs a calm, dependable product underneath it.

Visual direction: a compact, original impish lookout character or expressive signal icon, heavy readable lettering, warm off-white and charcoal with one vivid accent. Keep the tray icon recognizable at 16 pixels. Show attention through shape and text as well as color, and reserve animation for brief meaningful changes with a reduced-motion alternative.

Use the attitude in the brand and optional playful copy. Keep operational states precise: working, needs input, turn ended, error, stale, unknown. A joke must never obscure whether the user needs to act. Spanish branding does not require a Spanish-only interface.

## Shortlist

| Name | Why it fits | Tradeoff |
| --- | --- | --- |
| **Follón** | Strongest personality; the chaos of several agents, brought under control | Accent in the display name; intentionally mischievous rather than corporate |
| **Alquite** | From “estar al quite”: attentive and ready to step in | Best serious alternative; meaning is less obvious outside Spanish |
| **Trasteo** | Suggests tinkering and a hands-on developer tool | Less directly about monitoring; means moving house in some Spanish-speaking regions |
| **Ojito** | Excellent watching/attention metaphor; friendly eye mascot | An existing software product already uses it for monitoring and alerts |

Among the word-based options, my ranking is **Follón**, **Alquite**, then **Trasteo**. Ojito remains a good creative direction but moves down after the broader collision search.

## Names with visible collisions

These are observed uses, not conclusions about legal availability:

| Name | Existing use found | Effect on the shortlist |
| --- | --- | --- |
| Ojito | [Ojito](https://ojitoapp.com/) monitors rental listings and sends alerts | Similar monitoring promise makes it harder to distinguish |
| Jaleo | [Jaleo](https://jaleo.tech/) is already an AI-related product name | Too close to the space we want to enter |
| Al Loro / Alloro | [Alloro](https://www.getalloro.com/benefits) offers AI services for local businesses | The obvious spelling loses distinctiveness |
| Tramoya | [Tramoya on PyPI](https://pypi.org/project/tramoya/) is an existing Python state-machine library | Attractive backstage metaphor, already a software name |
| Pillín | [Pillin](https://www.pillin.com/) is an established clothing brand | Less distinctive even outside developer tools |
| Chivato | [Chivato on Google Play](https://play.google.com/store/apps/details?id=com.marcmnc.chivato) and [Tu Chivato on the App Store](https://apps.apple.com/es/app/tu-chivato/id6772690228) already use the name | Another crowded alerting/informer metaphor |

Exact-name web searches for the shortlisted words alongside software, app, AI, and monitoring terms were an initial collision screen. They do not establish domain, package, repository, or trademark availability. Those checks should use the final candidate and intended distribution regions before a public launch.

## Rebrand scope after choosing

Introduce the public name, icon, window titles, and onboarding together. Keep existing configuration locations and command aliases readable during migration, and preserve project/session identities. Review installer identity, autostart registration, notification app identity, and update channels before changing them.

The current canonical Clawd reference remains intact. A neutral product identity can sit above provider-specific characters; a later mascot redesign should be a separate design decision.
