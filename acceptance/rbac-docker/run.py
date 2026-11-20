"""Real Compose acceptance. No production resources or external application transport."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
# Keep setup inside the evidence handler, including failures on a repeated run.
OUT = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else HERE / 'local-evidence'
COMPOSE = None


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

def first_ack(result, text=None):
    acknowledgements = [c['payload'] for c in result['calls'] if c['method'] == 'answerCallbackQuery']
    assert acknowledgements, 'Missing answerCallbackQuery'
    if text is not None:
        assert text in acknowledgements[0].get('text', ''), acknowledgements[0]

def preview(actor=101, target=103, role='supervisor'):
    click('sn:list:0', actor)
    click(f'sn:pick:{target}:0', actor)
    result, _ = click(f'sn:access:{target}', actor)
    result, _ = click(button(result, f'sn:change:{target}:{role}:'), actor)
    return button(result, f'sn:apply:{target}:{role}:')

def application_etag(confirmation):
    etag = confirmation.rsplit(':', 1)[-1]
    assert len(etag) == 24 and all(c in '0123456789abcdef' for c in etag), confirmation
    return etag

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
        run([os.environ['NODE24_BIN'], str(TREE / 'deploy/vm3902/check-runtime.cjs'), str(CONFIG),
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
backup = (json.dumps(initial) + '\n').encode()  # Synthetic JSON is valid YAML.
SCENARIOS = ['old_readonly_callback_unchanged', 'authorized_callback_one_audit_preserved_fields', 'application_callback_etag_changes_with_saved_state', 'same_update_id_fresh_confirmation_no_calls_no_audit', 'fresh_update_id_control_applies_same_confirmation_once', 'second_admin_invalidates_card_no_extra_audit', 'authority_revoked_between_preview_and_apply_no_audit', 'compose_restart_new_process_same_role_and_audit', 'stale_no_second_audit', 'insufficient_authority_no_second_audit', 'replay_no_second_audit', 'application_rollback_one_audit_stale_repeat_refused', 'backup_restore_old_readonly_package_original_state']
evidence = {'status': 'RUNNING', 'candidate_sha': None, 'run_url': None, 'contracts': [], 'checks': []}
try:
    OUT.mkdir(parents=True, exist_ok=True)
    if len(sys.argv) != 3:
        raise ValueError('usage: run.py BUILD_INPUT EVIDENCE_DIRECTORY')
    TREE = Path(sys.argv[1]).resolve()
    evidence['provenance'] = json.loads((OUT / 'provenance.json').read_text())
    evidence['candidate_sha'] = evidence['provenance']['candidate_sha']
    if os.environ.get('GITHUB_REPOSITORY') and os.environ.get('GITHUB_RUN_ID'):
        evidence['run_url'] = ('https://github.com/' + os.environ['GITHUB_REPOSITORY']
                               + '/actions/runs/' + os.environ['GITHUB_RUN_ID'])
    LAB = OUT / 'private-synthetic'
    LAB.mkdir(mode=0o700)
    CONFIG = LAB / 'config'
    CONFIG.mkdir(mode=0o700)
    FILE = CONFIG / 'config.yaml'
    PROJECT = 'rbac-lab-' + os.environ.get('GITHUB_RUN_ID', str(os.getpid())) + '-' + os.environ.get('GITHUB_RUN_ATTEMPT', '1')
    os.environ.update(LAB_TAG=PROJECT, LAB_CONFIG=str(CONFIG),
                      LAB_TARGET='/bot/config', LAB_READONLY='false')
    COMPOSE = ['docker', 'compose', '--project-name', PROJECT, '--file', str(HERE / 'compose.yaml')]
    assert run([os.environ['NODE24_BIN'], '--version']).strip().startswith('v24.')
    FILE.write_bytes(backup)
    FILE.chmod(0o600)
    run(['sudo', 'chown', '-R', '1000:1000', str(LAB)])
    evidence.update(kernel=run(['uname', '-srmo']).strip(),
                    docker=run(['docker', 'version', '--format', '{{json .}}']).strip(),
                    compose=run(['docker', 'compose', 'version', '--short']).strip())
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
    first_ack(result, 'недоступна для записи')
    evidence['checks'].append('old_readonly_callback_unchanged')
    before = mount('new')
    confirmation = preview()
    original_application_etag = application_etag(confirmation)
    assert original_application_etag == before['etag']
    stale_confirmation = confirmation
    result, replay = click(confirmation)
    first_ack(result, 'Сохранено.')
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
    # A fresh, otherwise valid confirmation makes this a dedup regression:
    # without the Mongo update_id claim this would add a second audit entry.
    fresh = preview(role='agent')
    saved_application_etag = application_etag(fresh)
    assert saved_application_etag == after['etag']
    assert saved_application_etag != original_application_etag
    evidence['application_callback_etags'] = {'before': original_application_etag, 'after': saved_application_etag}
    evidence['checks'].append('application_callback_etag_changes_with_saved_state')
    duplicate = copy.deepcopy(replay)
    duplicate['callback_query']['data'] = fresh
    rejected, _ = click('', update=duplicate)
    assert rejected['calls'] == [], rejected
    assert durable(api('state')) == durable(after)
    evidence['checks'].append('same_update_id_fresh_confirmation_no_calls_no_audit')
    fresh_update = copy.deepcopy(duplicate)
    fresh_update['update_id'] += 1000000
    fresh_update['callback_query']['id'] = 'fresh-control'
    accepted, _ = click('', update=fresh_update)
    first_ack(accepted, 'Сохранено.')
    control = api('state')
    assert control['value']['staff_roles'][2]['role'] == 'agent'
    assert len(control['value']['team_settings_history']) == 2
    assert control['etag'] != after['etag']
    evidence['checks'].append('fresh_update_id_control_applies_same_confirmation_once')

    # Admin 102 changes the same employee while 101 holds an old card.
    stale = preview()
    second = preview(actor=102)
    accepted, _ = click(second, actor=102)
    first_ack(accepted, 'Сохранено.')
    after = api('state')
    assert len(after['value']['team_settings_history']) == 3
    assert after['value']['team_settings_history'][-1]['actor'] == '102'
    assert after['etag'] != control['etag']
    rejected, _ = click(stale)
    first_ack(rejected, 'устарела')
    assert durable(api('state')) == durable(after)
    evidence['checks'].append('second_admin_invalidates_card_no_extra_audit')

    # 102 previews while authorized; owner 101 then removes that authority.
    pending = preview(actor=102, role='agent')
    demote = preview(target=102, role='agent')
    accepted, _ = click(demote)
    first_ack(accepted, 'Сохранено.')
    after = api('state')
    assert len(after['value']['team_settings_history']) == 4
    rejected, _ = click(pending, actor=102)
    first_ack(rejected, 'администратору')
    assert durable(api('state')) == durable(after)
    evidence['checks'].append('authority_revoked_between_preview_and_apply_no_audit')

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
            first_ack(rejected, reason)
        else:
            assert rejected['calls'] == []
        evidence['checks'].append(label + '_no_second_audit')
    # Exercise application rollback with the same permission and etag checks.
    result, _ = click('sn:undo')
    undo = button(result, 'sn:undoapply:')
    accepted, _ = click(undo)
    first_ack(accepted, 'Откат сохранён.')
    undone = api('state')
    expected_undo = copy.deepcopy(after['value']['staff_roles'])
    expected_undo[1] = initial['staff_roles'][1]
    assert undone['value']['staff_roles'] == expected_undo
    assert undone['runtime'] == expected_undo
    assert len(undone['value']['team_settings_history']) == 5
    assert undone['etag'] != after['etag']
    rejected, _ = click(undo)
    first_ack(rejected, 'устарела')
    assert durable(api('state')) == durable(undone)
    evidence['checks'].append('application_rollback_one_audit_stale_repeat_refused')
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
    refused, _ = click(preview())
    first_ack(refused, 'недоступна для записи')
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
    # Cleanup must neither mask the primary failure nor leave a false PASS.
    if COMPOSE is not None:
        try:
            compose('down', '--volumes', '--remove-orphans')
        except Exception as cleanup_error:
            evidence['cleanup_error'] = type(cleanup_error).__name__ + ': ' + str(cleanup_error)[:300]
            evidence['status'] = 'BLOCKED'
    evidence['scenarios'] = {name: ('PASS' if name in evidence['checks'] else 'NOT_COMPLETED')
                             for name in SCENARIOS}
    (OUT / 'result.json').write_text(json.dumps(evidence, indent=2) + '\n')
    if evidence.get('cleanup_error') and sys.exc_info()[0] is None:
        raise SystemExit(1)

