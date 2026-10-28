import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('migrate', Path(__file__).resolve().parents[1]/'scripts/migrate-data.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.source = self.root/'snapshot'
        self.notes = self.root/'notes-source'
        self.destination = self.root/'linux'
        self.source.mkdir()
        self.notes.mkdir()
        (self.source/'text').mkdir()
        (self.source/'media').mkdir()
        (self.source/'text/a.txt').write_text('原始文字不改变。')
        (self.source/'text/unreferenced.txt').write_text('未引用的旧产物也保留。')
        (self.notes/'a.md').write_text('# 原笔记\n内容完整保留。')
        (self.source/'media/a.mp4').write_bytes(b'media-fixture')
        (self.source/'dustoff.conf').write_text('# 原注释\nDUST_LLM_KEY=fixture-key\nDUST_NOTES=/old/notes\n')
        db = sqlite3.connect(self.source/'index.sqlite')
        db.executescript('CREATE TABLE items(id TEXT,platform TEXT,media_path TEXT,text_path TEXT,note_path TEXT,media_deleted INTEGER); CREATE TABLE daily_state(name TEXT,value TEXT); CREATE TABLE daily_queue(id TEXT,metadata TEXT); CREATE TABLE daily_usage(day TEXT,id TEXT);')
        db.execute('INSERT INTO items VALUES(?,?,?,?,?,?)', ('1','douyin','/old/home/media/a.mp4','/old/home/text/a.txt','/old/notes/a.md',0))
        db.execute('INSERT INTO items VALUES(?,?,?,?,?,?)', ('2','douyin','/old/home/media/deleted.mp4',None,None,1))
        db.execute('INSERT INTO daily_state VALUES(?,?)', ('baseline','{"anchors":["1"]}'))
        db.commit()
        db.close()

    def tearDown(self):
        self.temp.cleanup()

    def run_migration(self):
        return module.migrate(self.source,self.notes,'/old/home','/old/notes',self.destination,gateway_base='http://127.0.0.1:8317')

    def test_complete_copy_and_path_mapping_preserve_source(self):
        before = module.digest(self.source/'index.sqlite')
        report = self.run_migration()
        self.assertEqual(report['tables']['items'], 2)
        self.assertEqual(report['previouslyDeletedMedia'], 1)
        self.assertEqual(report['verifiedArtifactFiles'], 4)
        self.assertEqual(module.digest(self.source/'index.sqlite'), before)
        db = sqlite3.connect(self.destination/'index.sqlite')
        self.assertEqual(db.execute("SELECT note_path FROM items WHERE id='1'").fetchone()[0], str(self.destination/'notes/a.md'))
        self.assertEqual(db.execute('SELECT value FROM daily_state').fetchone()[0], '{"anchors":["1"]}')
        db.close()
        self.assertEqual((self.destination/'notes/a.md').read_bytes(), (self.notes/'a.md').read_bytes())
        conf = (self.destination/'dustoff.conf').read_text()
        self.assertIn('DUST_LLM_KEY=fixture-key', conf)
        self.assertIn('DUST_LLM_BASE=http://127.0.0.1:8317/v1/chat/completions', conf)
        with self.assertRaises(ValueError):
            self.run_migration()

    def test_missing_active_artifact_aborts_before_creating_destination(self):
        (self.source/'text/a.txt').unlink()
        with self.assertRaisesRegex(ValueError,'有效产物缺失'):
            self.run_migration()
        self.assertFalse(self.destination.exists())

    def test_unknown_path_aborts(self):
        db=sqlite3.connect(self.source/'index.sqlite')
        db.execute("UPDATE items SET note_path='/outside/a.md' WHERE id='1'")
        db.commit();db.close()
        with self.assertRaisesRegex(ValueError,'未映射'):
            self.run_migration()
        self.assertFalse(self.destination.exists())


if __name__ == '__main__':
    unittest.main()
