'use strict';

/**
 * Pet view: draws the cat that PetDirector (lib/pet.js) moves around. One
 * <div class="buddy-pet"> inside #actors, placed like the minis (outward
 * offsets from the slot edge). The cat never takes the mouse.
 *
 * Attributes on the wrapper: data-phase, data-walk, data-travel, data-rest,
 * data-flip (app CSS mirrors it).
 */
(() => {
  const { PetDirector } = window.BuddyPet;

  /**
   * @param {object} o
   * @param {HTMLElement} o.actors
   * @param {(markup: string) => SVGElement} o.sanitizeSvg
   * @param {(name: string, on: boolean) => void} o.onCue  'play' / 'cuddle' / 'laser' starts / ends
   * @param {(phase: string | null) => void} [o.onPhase]  enter, play, aside, nap, cuddle, laser, leave; null: gone
   * @param {(message: string) => void} o.trace
   */
  function createPetView(o) {
    let template = null;
    let el = null;
    let side = 'left';
    let rest = false;
    let travel = null;
    let wanted = false;
    let last = null;

    const director = new PetDirector({
      // Half the time the laser pointer comes out after the ball.
      timings: { laserAfterPlay: 0.5 },
      onUpdate: render,
      onCue: (name, on) => o.onCue(name, on),
      onPhase: (phase) => o.onPhase && o.onPhase(phase),
      onGone: () => {
        if (el) el.remove();
        el = null;
        last = null;
        o.trace('cat: gone');
      },
    });

    /** pet: { svgUrl, cssUrl } or null (this character has no pet). */
    async function setPet(pet) {
      director.dispose();
      if (el) el.remove();
      el = null;
      template = null;
      const oldLink = document.getElementById('pet-css');
      if (!pet) {
        if (oldLink) oldLink.remove();
        return;
      }
      const link = document.createElement('link');
      link.id = 'pet-css';
      link.rel = 'stylesheet';
      link.href = pet.cssUrl;
      const response = await fetch(pet.svgUrl);
      template = o.sanitizeSvg(await response.text());
      if (oldLink) oldLink.replaceWith(link);
      else document.head.appendChild(link);
      if (wanted) director.call();
    }

    function setLayout(layout) {
      side = layout && layout.side === 'right' ? 'right' : 'left';
      if (layout && layout.pet) {
        o.actors.style.setProperty('--pet-size', `${layout.pet.size || 96}px`);
        director.setGeometry(layout.pet);
      }
      if (last) render(last);
    }

    /** Called (true) or sent away (false) from the menu. */
    function setOn(on) {
      wanted = Boolean(on);
      if (!template) return;
      if (wanted) {
        o.trace('cat: called');
        director.call();
      } else {
        director.dismiss();
      }
    }

    function interrupt() {
      director.interrupt();
    }

    /** The idle story: the cat comes close to be petted (false: not here yet, or leaving). */
    function cuddle() {
      if (!template) return false;
      return director.cuddle();
    }

    /** The laser pointer: the cat wakes up and chases the dot (false: not here, or busy). */
    function laser() {
      if (!template) return false;
      return director.laser();
    }

    function setRest(value) {
      rest = Boolean(value);
      if (last) render(last);
    }

    function setTravel(mode, face) {
      travel = mode ? { mode, face: face === 'left' ? 'left' : 'right' } : null;
      if (last) render(last);
    }

    function render(view) {
      if (!template) return;
      last = view;
      if (!el) {
        el = document.createElement('div');
        el.className = 'buddy-pet';
        el.appendChild(template.cloneNode(true));
        o.actors.appendChild(el);
      }
      const set = (name, on, value = '1') => {
        if (on) el.dataset[name] = value;
        else delete el.dataset[name];
      };
      if (el.dataset.phase !== view.phase) o.trace(`cat: ${view.phase}`);
      el.dataset.phase = view.phase;
      // The artwork faces right; "in" = towards the main character.
      const faceRight = travel ? travel.face !== 'left' : side === 'left' ? view.face === 'in' : view.face === 'out';
      set('flip', !faceRight);
      set('walk', view.walkMs > 0);
      set('travel', Boolean(travel), travel ? travel.mode : '');
      set('rest', rest);
      el.style.setProperty('--off', `${view.off}px`);
      el.style.setProperty('--walk', `${view.walkMs}ms`);
    }

    return {
      setPet,
      setLayout,
      setOn,
      interrupt,
      cuddle,
      laser,
      setRest,
      setTravel,
      get here() {
        return director.here;
      },
    };
  }

  window.BuddyPetView = { createPetView };
})();
