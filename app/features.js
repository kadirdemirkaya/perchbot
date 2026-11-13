'use strict';

/**
 * Features that are built but switched off for now. A switched-off feature has
 * no menu entry, ignores its setting and loads no code in the page.
 *
 *   sound  little sounds made in code (app/renderer/lib/sound.js). Off until
 *          the sounds get another pass. To bring them back: set this to true
 *          and put the lib/sound.js script tag back in app/renderer/index.html
 *          (a test checks that the two agree).
 */
module.exports = Object.freeze({ sound: false });
