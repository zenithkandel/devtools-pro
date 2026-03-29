browser/chromium extension
this extension when loaded gets to work in the devtools. it will make a new section named devtools-pro
from that place, we can monitor all the incoming and outgoing network requests similar to that of the networks tab.
all the features from the network tab will be available in our devtools-pro tab
the extra features will be:

1. new intrude mode:
   1. intrude mode will be able to intercept the request, modify them and forward them similar to burp suite.
   2. 2 modes in intrude mode:
      1. no js no forward mode:
         - all js execution will be temporarily paused
         - all network request will be funneled and the payload and the headers can be modified by the user and then forwarded and js can also be enabled simultaneously
      2. yes js no forward mode:
         - all js execution will work as normal
         - all network requests will be funneled and the payload and the headers can be modified by the user and then forwarder
