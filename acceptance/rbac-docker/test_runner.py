"""Failure-path tests; no Docker daemon or application data is accessed."""
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch


class RunnerFailureTests(unittest.TestCase):
    def exercise(self, existing_lab):
        runner = Path(__file__).with_name('run.py')
        with tempfile.TemporaryDirectory(prefix='rbac-runner-test-') as tmp:
            out = Path(tmp)
            (out / 'provenance.json').write_text(json.dumps({'candidate_sha': 'synthetic-sha'}))
            if existing_lab:
                (out / 'private-synthetic').mkdir()
            with patch.object(sys, 'argv', [str(runner), tmp, tmp]), \
                 patch.dict(os.environ, {'NODE24_BIN': 'synthetic-node'}, clear=True), \
                 patch('subprocess.check_output', side_effect=[
                     RuntimeError('primary failure'), RuntimeError('cleanup failure')
                 ]) as command:
                with self.assertRaises(FileExistsError if existing_lab else RuntimeError) as caught:
                    runpy.run_path(str(runner), run_name='__main__')
                result = json.loads((out / 'result.json').read_text())
                self.assertEqual(result['status'], 'BLOCKED')
                self.assertEqual(result['candidate_sha'], 'synthetic-sha')
                self.assertIsNone(result['run_url'])
                if existing_lab:
                    command.assert_not_called()
                else:
                    self.assertEqual(str(caught.exception), 'primary failure')
                    self.assertIn('primary failure', result['reason'])
                    self.assertIn('cleanup failure', result['cleanup_error'])

    def test_existing_lab_still_writes_blocked_result(self):
        self.exercise(existing_lab=True)

    def test_cleanup_error_keeps_primary_failure(self):
        self.exercise(existing_lab=False)


if __name__ == '__main__':
    unittest.main()

