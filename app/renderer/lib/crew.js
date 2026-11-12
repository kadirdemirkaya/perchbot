/*
 * CrewDirector: choreography of the sub-agent "minis" next to the main
 * character. Pure logic, no DOM, injectable clock and random, so the same file
 * runs in the renderer (window.BuddyCrew) and in node:test.
 *
 * Positions are OUTWARD offsets (CSS px) from the slot edge that faces the
 * crew, to a mini's foot centre (see app/placement.js CREW):
 *
 *   [ spot 3 | spot 2 | spot 1 | spot 0 |  report point  ][ main character ]
 *
 * The life of one mini (it stays on screen until its agent finishes):
 *
 *   arrive   drops in with its thrusters: at the report point when it is free
 *            (then "brief": the main character explains the task), otherwise
 *            straight at its spot
 *   walk     to its spot (hops over other minis on the way)
 *   work     laptop open. Now and then it gets up ("social" moments):
 *              chat   walks over to a neighbour; they talk and pass a note
 *              visit  walks (or flies) to the main character for a word
 *              stroll wanders off a bit, looks around, comes back
 *   held     the user picked it up; when dropped it lands there and makes that
 *            place its new spot
 *   shooed   hit too often: it huffs, then walks (or hops) off to a random new
 *            spot in the crew area and works there
 *   done     the agent finished: a happy face, then it waits for the report point
 *   report   salutes and hands its note to the main character
 *   leave    flies off; then onRelease(id) so the app can forget the agent
 *
 * An agent that disappears for other reasons (session ended, no events for a
 * long time: status "gone") leaves quietly without reporting.
 *
 * Facing: "in" = towards the main character, "out" = away from it.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BuddyCrew = api;
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const realClock = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };

  const DEFAULT_TIMINGS = Object.freeze({
    arriveMs: 700,
    briefMs: 1700,
    /** Walking speed in px per ms (160 px/s) and the shortest walk. */
    walkSpeed: 0.16,
    minWalkMs: 250,
    doneMs: 600,
    reportMs: 1600,
    leaveMs: 900,
    goneMs: 600,
    chatMs: 2600,
    /** When, inside a chat or a report, the note changes hands. */
    handoffAtMs: 1000,
    /** Looking around at the end of a stroll. */
    lookMs: 1800,
    /** Landing after the user dropped it. */
    landMs: 500,
    /** A social moment starts this long after the previous one (random in between). */
    socialMinMs: 15000,
    socialMaxMs: 35000,
    /** Distance between two minis facing each other in a chat (laptops closed). */
    chatGap: 72,
    /** Strolls stay this far out from the report point. */
    strollMargin: 70,
    /** Shooed away: the huff, and how far it goes at least. */
    huffMs: 700,
    shooGap: 60,
  });

  const AGENT_ID_RE = /^[a-f0-9]{6,16}$/;
  /** Relative weights of the social moments (when each is possible). Most often: a word with the main character. */
  const SOCIAL_WEIGHTS = { chat: 3, visit: 5, stroll: 2 };

  class CrewDirector {
    /**
     * @param {object} o
     * @param {{setTimeout: Function, clearTimeout: Function}} [o.clock]
     * @param {() => number} [o.random]
     * @param {number} [o.tints]  colour variants the character offers
     * @param {(mini: object) => void} [o.onUpdate]  create or redraw a mini
     * @param {(id: string) => void} [o.onRemove]  take a mini off the page
     * @param {(id: string) => void} [o.onRelease]  the agent can be forgotten
     * @param {(name: string, data: object) => void} [o.onCue]  'brief' | 'talk' | 'receive' | 'handoff'
     * @param {(count: number) => void} [o.onOverflow]  agents that do not fit ("+N")
     */
    constructor(o = {}) {
      this.clock = o.clock || realClock;
      this.random = o.random || Math.random;
      this.tints = Math.max(1, o.tints | 0 || 1);
      this.t = { ...DEFAULT_TIMINGS, ...(o.timings || {}) };
      this.onUpdate = o.onUpdate || (() => {});
      this.onRemove = o.onRemove || (() => {});
      this.onRelease = o.onRelease || (() => {});
      this.onCue = o.onCue || (() => {});
      this.onOverflow = o.onOverflow || (() => {});
      this.geo = { report: 0, spots: [], capacity: 0 };
      this.agents = [];
      /** @type {Map<string, Mini>} */
      this.minis = new Map();
      /** Agents we released; ignored until the app's list no longer has them. */
      this.departed = new Set();
      /** The mini using the report point (briefing, visiting, reporting), or null. */
      this.reportHolder = null;
      this.reportQueue = [];
      this.overflow = 0;
      this.shown = 0;
      this.quiet = false;
      this.socialTimer = null;
      this.disposed = false;
    }

    // ---------------------------------------------------------------- input

    setGeometry({ report = 0, spots = [], capacity = 0 } = {}) {
      this.geo = { report, spots: spots.slice(0, capacity), capacity: Math.min(capacity, spots.length) };
      this.sync(true);
    }

    /** The app's agent list (AgentRegistry.list()), in arrival order. */
    setAgents(list) {
      this.agents = (Array.isArray(list) ? list : []).filter(
        (a) => a && typeof a.id === 'string' && AGENT_ID_RE.test(a.id),
      );
      this.sync(false);
    }

    /** Quiet (main character resting, screen locked): nobody gets up. */
    setQuiet(quiet) {
      this.quiet = Boolean(quiet);
      this.scheduleSocial();
    }

    /** The user picked a mini up. */
    grab(id) {
      const mini = this.minis.get(id);
      if (!mini || mini.phase === 'leave' || mini.phase === 'held') return false;
      this.clearTimer(mini);
      this.leavePartner(mini);
      if (this.reportHolder === mini.id) {
        // Interrupted while reporting: it reports again after landing.
        this.reportHolder = null;
        this.nextReport();
      }
      this.reportQueue = this.reportQueue.filter((x) => x !== mini.id);
      mini.phase = 'held';
      mini.fly = true;
      mini.walkMs = 0;
      this.emit(mini);
      this.scheduleSocial();
      return true;
    }

    /** ... and dropped it at outward offset `off`: it lands and stays there. */
    dropAt(id, off) {
      const mini = this.minis.get(id);
      if (!mini || mini.phase !== 'held') return;
      const at = Math.round(Math.max(this.geo.report, Math.min(this.maxOff(), Number(off) || 0)));
      mini.home = at;
      mini.off = at;
      mini.phase = 'land';
      mini.walkMs = this.t.landMs;
      this.emit(mini);
      this.after(mini, this.t.landMs, () => {
        mini.fly = false;
        mini.walkMs = 0;
        this.work(mini);
      });
    }

    /**
     * Hit too often: an angry moment, then off to a random other spot in the
     * crew area (at least `shooGap` away), which becomes its spot.
     */
    shoo(id) {
      const mini = this.minis.get(id);
      if (!mini || mini.finishing || !['work', 'chat', 'look', 'walk', 'brief'].includes(mini.phase)) return false;
      this.clearTimer(mini);
      this.leavePartner(mini);
      if (this.reportHolder === mini.id) {
        this.reportHolder = null;
        this.nextReport();
      }
      const lo = this.geo.report + this.t.strollMargin;
      const hi = Math.max(lo, this.maxOff());
      let target = mini.off;
      for (let i = 0; i < 10 && Math.abs(target - mini.off) < this.t.shooGap; i += 1) target = Math.round(lo + this.random() * (hi - lo));
      if (Math.abs(target - mini.off) < this.t.shooGap) target = mini.off - lo > hi - mini.off ? lo : hi;
      this.setPhase(mini, 'huff', mini.face);
      this.after(mini, this.t.huffMs, () => {
        mini.home = target;
        this.walk(mini, target, () => this.work(mini));
      });
      return true;
    }

    list() {
      return [...this.minis.values()].map((m) => this.view(m));
    }

    dispose() {
      this.disposed = true;
      for (const mini of this.minis.values()) this.clearTimer(mini);
      this.clock.clearTimeout(this.socialTimer);
      this.minis.clear();
    }

    // ---------------------------------------------------------------- sync

    sync(relayout) {
      if (this.disposed) return;
      const listed = new Set(this.agents.map((a) => a.id));
      for (const id of this.departed) if (!listed.has(id)) this.departed.delete(id);

      // Finished before it could ever be shown (e.g. it waited behind "+N"): no scene.
      const candidates = [];
      for (const agent of this.agents) {
        if (this.departed.has(agent.id)) continue;
        if (agent.status !== 'active' && !this.minis.has(agent.id)) {
          this.release(agent.id);
          continue;
        }
        candidates.push(agent);
      }
      const visible = candidates.slice(0, this.geo.capacity);
      this.shown = visible.length;
      const shown = new Set(visible.map((a) => a.id));
      for (const mini of [...this.minis.values()]) if (!shown.has(mini.id)) this.drop(mini);

      visible.forEach((agent, slot) => {
        let mini = this.minis.get(agent.id);
        if (!mini) {
          this.arrive(agent, slot);
          return;
        }
        mini.agent = agent;
        mini.slot = slot;
        // A spot the user picked must stay inside the (possibly smaller) crew area.
        if (mini.home !== null && mini.home > this.maxOff()) mini.home = this.maxOff();
        if (agent.status !== 'active' && !mini.finishing) {
          mini.finishing = agent.status;
          if (mini.phase === 'work') this.finish(mini);
        } else if (mini.phase === 'work' && mini.off !== this.spotOf(mini)) {
          // A neighbour left: slide along towards the main character.
          if (relayout) this.place(mini, this.spotOf(mini), 'in');
          else this.walk(mini, this.spotOf(mini), () => this.work(mini));
          return;
        } else if (relayout) {
          this.relayout(mini);
        }
        this.emit(mini);
      });

      const overflow = candidates.length - visible.length;
      if (overflow !== this.overflow) {
        this.overflow = overflow;
        this.onOverflow(overflow);
      }
      this.scheduleSocial();
    }

    spot(slot) {
      return this.geo.spots[slot] !== undefined ? this.geo.spots[slot] : this.geo.report;
    }

    /** Where this mini works: the place the user dropped it, or its slot. */
    spotOf(mini) {
      return mini.home !== null ? mini.home : this.spot(mini.slot);
    }

    /** The outermost place a mini may stand (the window is just wide enough for it). */
    maxOff() {
      return this.spot(Math.max(0, this.shown - 1));
    }

    // ---------------------------------------------------------------- scenes

    arrive(agent, slot) {
      const atReport = this.reportHolder === null;
      const mini = {
        id: agent.id,
        agent,
        slot,
        home: null,
        tint: this.freeTint(),
        phase: 'arrive',
        off: atReport ? this.geo.report : this.spot(slot),
        face: 'in',
        fly: true,
        walkMs: 0,
        timer: null,
        finishing: null,
        partner: null,
      };
      this.minis.set(mini.id, mini);
      if (atReport) this.reportHolder = mini.id;
      this.emit(mini);
      this.after(mini, this.t.arriveMs, () => {
        mini.fly = false;
        if (atReport) this.brief(mini);
        else this.work(mini);
      });
    }

    brief(mini) {
      this.setPhase(mini, 'brief', 'in');
      this.onCue('brief', { id: mini.id });
      this.after(mini, this.t.briefMs, () => {
        this.freeReport(mini);
        if (mini.finishing) this.finish(mini);
        else this.walk(mini, this.spotOf(mini), () => this.work(mini));
      });
    }

    work(mini) {
      if (mini.finishing) {
        this.finish(mini);
        return;
      }
      mini.partner = null;
      this.setPhase(mini, 'work', 'in');
      this.scheduleSocial();
    }

    finish(mini) {
      this.clearTimer(mini);
      this.leavePartner(mini);
      if (mini.finishing === 'gone') {
        this.setPhase(mini, 'leave', mini.face);
        this.after(mini, this.t.goneMs, () => this.depart(mini));
        return;
      }
      this.setPhase(mini, 'done', 'in');
      this.after(mini, this.t.doneMs, () => this.queueReport(mini));
    }

    queueReport(mini) {
      if (this.reportHolder === null) this.report(mini);
      else if (!this.reportQueue.includes(mini.id)) this.reportQueue.push(mini.id);
    }

    report(mini) {
      this.reportHolder = mini.id;
      this.walk(mini, this.geo.report, () => {
        this.setPhase(mini, 'report', 'in');
        this.onCue('receive', { id: mini.id });
        this.after(mini, this.t.handoffAtMs, () => {
          this.onCue('handoff', { from: mini.id, to: null });
          this.after(mini, Math.max(0, this.t.reportMs - this.t.handoffAtMs), () => {
            this.freeReport(mini);
            mini.fly = true;
            this.setPhase(mini, 'leave', 'out');
            this.after(mini, this.t.leaveMs, () => this.depart(mini));
          });
        });
      });
    }

    freeReport(mini) {
      if (this.reportHolder !== mini.id) return;
      this.reportHolder = null;
      this.nextReport();
    }

    nextReport() {
      while (this.reportQueue.length) {
        const next = this.minis.get(this.reportQueue.shift());
        if (next && next.phase === 'done') {
          this.report(next);
          return;
        }
      }
    }

    depart(mini) {
      this.clearTimer(mini);
      this.minis.delete(mini.id);
      this.onRemove(mini.id);
      this.release(mini.id);
      this.scheduleSocial();
    }

    release(id) {
      this.departed.add(id);
      this.onRelease(id);
    }

    /** Taken off the page at once (the app forgot it, or it no longer fits). */
    drop(mini) {
      this.clearTimer(mini);
      this.reportQueue = this.reportQueue.filter((id) => id !== mini.id);
      this.minis.delete(mini.id);
      this.onRemove(mini.id);
      this.leavePartner(mini);
      if (this.reportHolder === mini.id) {
        this.reportHolder = null;
        this.nextReport();
      }
    }

    /** Geometry changed (dragged to the other side, size changed): jump into place. */
    relayout(mini) {
      if (mini.phase === 'work' || mini.phase === 'arrive') mini.off = this.spotOf(mini);
      else if (mini.phase === 'brief' || mini.phase === 'report') mini.off = this.geo.report;
      mini.walkMs = 0;
    }

    // ---------------------------------------------------------------- social moments

    /** Minis quietly working at their spot: they may get up. */
    idleWorkers() {
      return [...this.minis.values()].filter((m) => m.phase === 'work' && !m.finishing && m.off === this.spotOf(m));
    }

    scheduleSocial() {
      if (this.disposed) return;
      if (this.quiet || !this.idleWorkers().length) {
        this.clock.clearTimeout(this.socialTimer);
        this.socialTimer = null;
        return;
      }
      if (this.socialTimer) return;
      const delay = this.t.socialMinMs + this.random() * (this.t.socialMaxMs - this.t.socialMinMs);
      this.socialTimer = this.clock.setTimeout(() => {
        this.socialTimer = null;
        if (!this.quiet) this.socialMoment();
        this.scheduleSocial();
      }, delay);
    }

    socialMoment() {
      const workers = this.idleWorkers();
      if (!workers.length) return;
      const pairs = this.chatPairs(workers);
      const options = [];
      if (pairs.length) options.push('chat');
      if (this.reportHolder === null) options.push('visit');
      options.push('stroll');
      const total = options.reduce((sum, k) => sum + SOCIAL_WEIGHTS[k], 0);
      let pick = this.random() * total;
      const kind = options.find((k) => (pick -= SOCIAL_WEIGHTS[k]) < 0) || options[options.length - 1];
      const any = () => workers[Math.floor(this.random() * workers.length)];
      if (kind === 'chat') this.chat(...pairs[Math.floor(this.random() * pairs.length)]);
      else if (kind === 'visit') this.visit(any());
      else this.stroll(any());
    }

    /** Neighbours (nobody between them) that are both quietly working: [inner, outer]. */
    chatPairs(workers) {
      const all = [...this.minis.values()].sort((a, b) => a.off - b.off);
      const free = new Set(workers);
      const pairs = [];
      for (let i = 0; i + 1 < all.length; i += 1) {
        if (free.has(all[i]) && free.has(all[i + 1]) && all[i + 1].off - all[i].off > this.t.chatGap) {
          pairs.push([all[i], all[i + 1]]);
        }
      }
      return pairs;
    }

    chat(inner, outer) {
      inner.partner = outer.id;
      outer.partner = inner.id;
      this.setPhase(inner, 'chat', 'out');
      this.walk(outer, inner.off + this.t.chatGap, () => {
        if (outer.partner !== inner.id || !this.minis.has(inner.id)) {
          outer.partner = null;
          this.backToWork(outer);
          return;
        }
        this.setPhase(outer, 'chat', 'in');
        this.after(outer, this.t.handoffAtMs, () => {
          const [from, to] = this.random() < 0.5 ? [outer, inner] : [inner, outer];
          this.onCue('handoff', { from: from.id, to: to.id });
          this.after(outer, Math.max(0, this.t.chatMs - this.t.handoffAtMs), () => this.endChat(outer));
        });
      });
    }

    endChat(mini) {
      const partner = mini.partner ? this.minis.get(mini.partner) : null;
      for (const m of [mini, partner]) {
        if (!m || !this.minis.has(m.id)) continue;
        m.partner = null;
        this.backToWork(m);
      }
    }

    /** A word with the main character at the report point. */
    visit(mini) {
      this.reportHolder = mini.id;
      this.walk(mini, this.geo.report, () => {
        this.setPhase(mini, 'chat', 'in');
        this.onCue('talk', { id: mini.id });
        this.after(mini, this.t.chatMs, () => {
          this.freeReport(mini);
          this.backToWork(mini);
        });
      });
    }

    /** Wander off a little, look around, come back. */
    stroll(mini) {
      const lo = this.geo.report + this.t.strollMargin;
      const hi = Math.max(lo, this.maxOff());
      let target = Math.round(lo + this.random() * (hi - lo));
      if (Math.abs(target - mini.off) < 40) target = mini.off - lo > hi - mini.off ? lo : hi;
      this.walk(mini, target, () => {
        this.setPhase(mini, 'look', mini.face);
        this.after(mini, this.t.lookMs, () => this.backToWork(mini));
      });
    }

    backToWork(mini) {
      this.clearTimer(mini);
      if (mini.off === this.spotOf(mini)) this.work(mini);
      else this.walk(mini, this.spotOf(mini), () => this.work(mini));
    }

    /** It stops whatever it did with a partner; the partner goes back to work. */
    leavePartner(mini) {
      const partner = mini.partner ? this.minis.get(mini.partner) : null;
      mini.partner = null;
      if (!partner) return;
      partner.partner = null;
      // A partner already talking goes back; one still walking over notices on arrival.
      if (partner.phase === 'chat') this.backToWork(partner);
    }

    // ---------------------------------------------------------------- helpers

    walk(mini, off, then) {
      this.clearTimer(mini);
      const distance = Math.abs(off - mini.off);
      if (distance < 1) {
        mini.walkMs = 0;
        then();
        return;
      }
      const lo = Math.min(off, mini.off);
      const hi = Math.max(off, mini.off);
      // Somebody standing in the way: hop over them with the thrusters.
      mini.fly = [...this.minis.values()].some((m) => m !== mini && m.off > lo + 1 && m.off < hi - 1);
      mini.face = off > mini.off ? 'out' : 'in';
      mini.walkMs = Math.max(this.t.minWalkMs, Math.round(distance / this.t.walkSpeed));
      mini.off = off;
      mini.phase = 'walk';
      this.emit(mini);
      this.after(mini, mini.walkMs, () => {
        mini.fly = false;
        mini.walkMs = 0;
        then();
      });
    }

    place(mini, off, face) {
      mini.off = off;
      mini.face = face;
      mini.walkMs = 0;
      this.emit(mini);
    }

    setPhase(mini, phase, face) {
      this.clearTimer(mini);
      mini.phase = phase;
      mini.face = face;
      if (phase !== 'leave') mini.fly = false;
      mini.walkMs = 0;
      this.emit(mini);
    }

    after(mini, ms, fn) {
      this.clearTimer(mini);
      mini.timer = this.clock.setTimeout(() => {
        mini.timer = null;
        if (!this.disposed && this.minis.get(mini.id) === mini) fn();
      }, ms);
    }

    clearTimer(mini) {
      if (mini.timer) this.clock.clearTimeout(mini.timer);
      mini.timer = null;
    }

    /** The lowest colour not worn by another mini right now (so neighbours differ). */
    freeTint() {
      const used = new Set([...this.minis.values()].map((m) => m.tint));
      for (let i = 0; i < this.tints; i += 1) if (!used.has(i)) return i;
      return this.minis.size % this.tints;
    }

    view(mini) {
      const a = mini.agent;
      return {
        id: mini.id,
        type: a.type,
        tool: a.tool || null,
        file: a.file || null,
        skill: a.skill || null,
        tint: mini.tint,
        slot: mini.slot,
        phase: mini.phase,
        off: mini.off,
        face: mini.face,
        fly: mini.fly,
        walkMs: mini.walkMs,
      };
    }

    emit(mini) {
      this.onUpdate(this.view(mini));
    }
  }

  /** Tooltip text for a mini: "Explore · Read · main.js". No descriptions, ever. */
  function crewLabel(mini) {
    return [mini.type, mini.tool, mini.file].filter((part) => typeof part === 'string' && part).join(' · ');
  }

  return { CrewDirector, crewLabel, CREW_TIMINGS: DEFAULT_TIMINGS };
});

/**
 * @typedef {object} Mini
 * @property {string} id
 * @property {object} agent  the app's entry: { id, type, tool, file, skill, status }
 * @property {number} slot  index among the visible minis (0 = next to the report point)
 * @property {number|null} home  where the user dropped it (overrides the slot's spot)
 * @property {number} tint  colour variant
 * @property {string} phase  arrive | brief | walk | work | chat | look | held | land | huff | done | report | leave
 * @property {number} off  outward offset of its feet (CSS px)
 * @property {'in'|'out'} face
 * @property {boolean} fly
 * @property {number} walkMs  duration of the current move (0 = jump)
 * @property {string|null} finishing  'done' | 'gone' once the agent finished
 * @property {string|null} partner  chat partner id
 */
