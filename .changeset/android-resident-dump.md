---
"@tapflowio/android-agent": patch
---

An Android UI tree read goes through the agent's resident field server instead of starting a process on the device for each read: about 0.3 s instead of 1.3 s on an emulator, and about 15 ms between reads while a person is recorded. The XML is the same as before. A read no longer lets go of the accessibility connection held while a person is recorded, so the first tap after a tree read is reported like any other. If the server cannot answer, the read goes the old way.
