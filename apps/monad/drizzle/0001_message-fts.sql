CREATE VIRTUAL TABLE IF NOT EXISTS `messages_fts`
USING fts5(`text`, content='messages', content_rowid='rowid');
--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS `messages_fts_trigram`
USING fts5(`text`, content='messages', content_rowid='rowid', tokenize='trigram');
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `messages_ai` AFTER INSERT ON `messages` BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
  INSERT INTO messages_fts_trigram(rowid, text) VALUES (new.rowid, new.text);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `messages_ad` AFTER DELETE ON `messages` BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO messages_fts_trigram(messages_fts_trigram, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `messages_au` AFTER UPDATE ON `messages` BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO messages_fts_trigram(messages_fts_trigram, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
  INSERT INTO messages_fts_trigram(rowid, text) VALUES (new.rowid, new.text);
END;
--> statement-breakpoint
INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
--> statement-breakpoint
INSERT INTO messages_fts_trigram(messages_fts_trigram) VALUES ('rebuild');
