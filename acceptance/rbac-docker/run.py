"""Real Compose acceptance. No production resources or external application transport."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
TREE = Path(sys.argv[1]).resolve()
OUT = Path(sys.argv[2]).resolve()
OUT.mkdir(parents=True, exist_ok=True)
LAB = OUT / 'private-synthetic'
LAB.mkdir(mode=0o700)
CONFIG = LAB / 'config'
CONFIG.mkdir(mode=0o700)
FILE = CONFIG / 'config.yaml'
PROJECT = 'rbac-lab-' + os.environ.get('GITHUB_RUN_ID', str(os.getpid())) + '-' + os.environ.get('GITHUB_RUN_ATTEMPT', '1')
os.environ.update(LAB_TAG=PROJECT, LAB_CONFIG=str(CONFIG),
                  LAB_TARGET='/bot/config', LAB_READONLY='false')
COMPOSE = ['docker', 'compose', '--project-name', PROJECT, '--file', str(HERE / 'compose.yaml')]

def run(args, capture=True):
    return subprocess.check_output(args, text=True) if capture else subprocess.run(args, check=True)

def compose(*args):
    return run(COMPOSE + list(args))

def api(path, update=None):
    js = "fetch('http://127.0.0.1:8099/" + path + "'," + json.dumps({
        'method': 'POST' if update else 'GET',
        **({'body': json.dumps(update)} if update else {})
    }) + ").then(async r=>{if(!r.ok)process.exit(2);console.log(await r.text())}).catch(()=>process.exit(3))"
    return json.loads(compose('exec', '-T', 'supportbot', 'node', '-e', js))

def ready():
    for _ in range(90):
        try:
            state = api('state')
            assert state['node'].startswith('v24.')
            return state
        except (subprocess.CalledProcessError, ValueError):
            time.sleep(1)
    raise RuntimeError('supportbot readiness timeout')

counter = 1000
def click(data, actor=101, update=None):
    global counter
    counter += 1
    update = update or {'update_id': counter, 'callback_query': {
        'id': str(counter), 'from': {'id': actor, 'is_bot': False, 'first_name': 'Synthetic'},
        'chat_instance': 'synthetic', 'data': data,
        'message': {'message_id': 100, 'date': 1, 'chat': {'id': actor, 'type': 'private'}, 'text': 'Synthetic panel'}
    }}
    return api('update', update), update

def button(result, prefix):
    for call in reversed(result['calls']):
        for row in call['payload'].get('reply_markup', {}).get('inline_keyboard', []):
            for item in row:
                if item.get('callback_data', '').startswith(prefix):
                    return item['callback_data']
    raise AssertionError('Expected application button missing: ' + prefix)

def preview():
    click('sn:list:0')
    click('sn:pick:103:0')
    result, _ = click('sn:access:103')
    result, _ = click(button(result, 'sn:change:103:supervisor:'))
    return button(result, 'sn:apply:103:supervisor:')

def durable(state):
    return {k: state[k] for k in ('etag', 'value', 'runtime')}

def contract(mode):
    container = json.loads(run(['docker', 'inspect', compose('ps', '-q', 'supportbot').strip()]))[0]
    host = container['HostConfig']
    assert host['ReadonlyRootfs'] and container['Config']['User'] == '1000:1000'
    assert 'ALL' in host['CapDrop'] and any('no-new-privileges' in x for x in host['SecurityOpt'])
    mounts = [{'destination': x['Destination'], 'rw': x['RW'], 'type': x['Type']} for x in container['Mounts']]
    assert not any('docker.sock' in x['Destination'] for x in container['Mounts'])
    target = '/bot/config' if mode == 'new' else '/bot/config/config.yaml'
    assert next(x for x in mounts if x['destination'] == target)['rw'] == (mode == 'new')
    assert len(compose('ps', '-q', 'supportbot').split()) == 1
    evidence['contracts'].append({'mode': mode, 'mounts': mounts, 'user': '1000:1000', 'read_only': True,
                                  'image_id': container['Image']})

def mount(mode):
    compose('stop', 'supportbot')
    compose('rm', '-f', 'supportbot')
    os.environ.update(LAB_CONFIG=str(CONFIG if mode == 'new' else FILE),
                      LAB_TARGET='/bot/config' if mode == 'new' else '/bot/config/config.yaml',
                      LAB_READONLY='false' if mode == 'new' else 'true')
    if mode == 'new':
        # Execute the unchanged package's directory and rendered-contract checks.
        run(['node', str(TREE / 'deploy/vm3902/check-runtime.cjs'), str(CONFIG),
             '--project-name', PROJECT, '--file', str(HERE / 'compose.yaml')])
    compose('up', '-d', 'supportbot')
    state = ready()
    contract(mode)
    return state

initial = {'bot_token': '999001:SYNTHETIC_ONLY', 'owner_id': 101, 'staffchat_id': -100999,
           'use_llm': False, 'synthetic_preserved': {'nested': ['unchanged', 42]},
           'staff_roles': [{'telegram_id': str(i), 'name': 'Synthetic ' + str(i), 'role': role, 'active': True}
                           for i, role in [(101, 'admin'), (102, 'admin'), (103, 'agent')]],
           'team_settings_history': []}
backup = (json.dumps(initial) + '\n').encode()  # JSON is valid YAML, includes only synthetic data.
FILE.write_bytes(backup)
FILE.chmod(0o600)
run(['sudo', 'chown', '-R', '1000:1000', str(LAB)])
evidence = {'status': 'RUNNING', 'contracts': [], 'checks': [], 'provenance': json.loads((OUT / 'provenance.json').read_text()),
            'kernel': run(['uname', '-srmo']).strip(),
            'docker': run(['docker', 'version', '--format', '{{json .}}']).strip(),
            'compose': run(['docker', 'compose', 'version', '--short']).strip()}
try:
    base_image = 'rbac-application:' + PROJECT
    run(['docker', 'build', '-t', base_image, str(TREE)], capture=False)
    evidence['application_image_id'] = run(['docker', 'image', 'inspect', '--format', '{{.Id}}', base_image]).strip()
    run(['docker', 'build', '--build-arg', 'BASE_IMAGE=' + base_image,
         '-t', 'rbac-acceptance:' + PROJECT, str(HERE)], capture=False)
    evidence['image_id'] = run(['docker', 'image', 'inspect', '--format', '{{.Id}}', 'rbac-acceptance:' + PROJECT]).strip()
    before = mount('old')
    confirmation = preview()
    result, _ = click(confirmation)
    assert durable(api('state')) == durable(before)
    assert any('недоступна для записи' in str(c['payload']) for c in result['calls'])
    evidence['checks'].append('old_readonly_callback_unchanged')
    before = mount('new')
    confirmation = preview()
    stale_confirmation = confirmation
    result, replay = click(confirmation)
    after = api('state')
    expected = copy.deepcopy(initial)
    expected['staff_roles'][2]['role'] = 'supervisor'
    history = after['value']['team_settings_history']
    assert len(history) == 1 and history[0]['actor'] == '101'
    assert history[0]['before'] == initial['staff_roles'][2] and history[0]['after'] == expected['staff_roles'][2]
    expected['team_settings_history'] = history
    assert after['value'] == expected and after['etag'] != before['etag']
    assert after['runtime'] == expected['staff_roles']
    evidence['checks'].append('authorized_callback_one_audit_preserved_fields')
    compose('restart', 'supportbot')
    restarted = ready()
    assert restarted['boot'] != after['boot'] and durable(restarted) == durable(after)
    evidence['checks'].append('compose_restart_new_process_same_role_and_audit')
    for label, data, actor, update, reason in [
        ('stale', stale_confirmation, 101, None, 'устарела'),
        ('insufficient_authority', stale_confirmation, 103, None, 'администратору'),
        ('replay', '', 101, replay, None),
    ]:
        rejected, _ = click(data, actor, update)
        assert durable(api('state')) == durable(after)
        if reason:
            assert any(reason in str(c['payload']) for c in rejected['calls'])
        else:
            assert all(c['method'] == 'answerCallbackQuery' for c in rejected['calls'])
        evidence['checks'].append(label + '_no_second_audit')
    compose('stop', 'supportbot')
    # Stopped sole writer: fsync sibling, atomic rename, directory fsync.
    temp = CONFIG / 'restore.tmp'
    with temp.open('wb') as out:
        out.write(backup); out.flush(); os.fsync(out.fileno())
    temp.chmod(0o600)
    run(['sudo', 'chown', '1000:1000', str(temp)])
    os.replace(temp, FILE)
    fd = os.open(CONFIG, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)
    restored = mount('old')
    assert restored['value'] == initial and restored['etag'] == before['etag']
    click(preview())
    assert durable(api('state')) == durable(restored)
    evidence['checks'].append('backup_restore_old_readonly_package_original_state')
    evidence.update(status='PASS', node=restarted['node'], replay_update_id=replay['update_id'],
                    etags={'before': before['etag'], 'after': after['etag'], 'restarted': restarted['etag'], 'restored': restored['etag']},
                    boot_ids={'saved': after['boot'], 'restarted': restarted['boot']},
                    before=before['value'], after=after['value'], restored=restored['value'])
except Exception as error:
    evidence.update(status='BLOCKED', reason=type(error).__name__ + ': ' + str(error)[:300])
    raise
finally:
    (OUT / 'result.json').write_text(json.dumps(evidence, indent=2) + '\n')
    compose('down', '--volumes', '--remove-orphans')
