Note: this project is a fork of sumatrapdf project on github. I modified the reader to suit my reading needs. I forked this project on Febuary 15th. 

I have made the following changes in diversion to the original projects:
* Revert smart alt+tab menu control. It now just the familiar alt+tab
* Make scrolling on touchpad sample the events at 60 fps instead of 5 fps like the orginal
* Change background color (hardcoded)
* Control+numbers are now shortcuts to change tabs. Previously it was for zoooming commands. Zooming commands are instead using alt+number shortcuts
* Reduce horizonal scroll sensitivity (hardcoded)
* Add middle button down to pan around just like on Fusion 360

TODO:
* Smooth scroll for mouse scroll wheel and arrow keys by a exponanicaly decay functinon

Persistance problems:
* When open two windows, the first window doesn't save states when sumatraPDF is closed
* Window multiple line scroll setting lead to the app crashing when open.
* Tabs drag and drop in the tab's bar doesn't provide enough feedback. This was updated in the sumatraPDF main branch after I forked from the main branch.


[![Build](https://github.com/sumatrapdfreader/sumatrapdf/actions/workflows/build.yml/badge.svg?branch=master)](https://github.com/sumatrapdfreader/sumatrapdf/actions/workflows/build.yml)
## SumatraPDF Reader

SumatraPDF is a multi-format (PDF, EPUB, MOBI, CBZ, CBR, FB2, CHM, XPS, DjVu) reader
for Windows under (A)GPLv3 license, with some code under BSD license (see
AUTHORS).

More Information:
* [Website](https://www.sumatrapdfreader.org/free-pdf-reader)
* [Manual](https://www.sumatrapdfreader.org/manual)
* [Developer Information](https://www.sumatrapdfreader.org/docs/Contribute-to-SumatraPDF)


