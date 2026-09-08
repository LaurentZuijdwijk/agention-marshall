// MAIN-world entry point for console capture; see console-capture.ts for what
// it installs and why it has to run in the page's own world.
import { installConsoleCapture } from './console-capture.js';

installConsoleCapture(window);
