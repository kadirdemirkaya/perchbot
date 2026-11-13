'use strict';

/**
 * Features that are built but switched off for now. A switched-off feature has
 * no menu entry, ignores its setting and loads no code in the page.
 *
 *   sound  little sounds made in code (app/renderer/lib/sound.js). Available
 *          again: the Sound setting (off by default) switches them on. To hide
 *          them again: set this to false and comment out the lib/sound.js
 *          script tag in app/renderer/index.html (a test checks that the two agree).
 */
module.exports = Object.freeze({ sound: true });
