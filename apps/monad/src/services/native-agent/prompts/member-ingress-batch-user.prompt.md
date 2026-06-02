Process this single managed project inbox batch.

<%= it.batchJson %>

Each `messages` entry contains its body and delivery metadata. Process entries in `ingressSeq` order. This batch is one logical turn. Once accepted, the entries are consumed and must not be requested or processed again.
