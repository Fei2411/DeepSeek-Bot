"""Run the real browser-use library (not a local reimplementation)."""
import asyncio
import json
import os
import sys
import urllib.request

from browser_use import Agent, ChatOpenAI
from browser_use.browser.profile import BrowserProfile

CHROME = os.environ['CHROME_PATH']
OUT = os.environ['UPSTREAM_OUT']
ORIGIN = os.environ['FIXTURE_ORIGIN']

TASKS = [
    ('shop', f'Open {ORIGIN}/ and report the price in yuan of the Cedar lamp. Search the shop. The price is not on the results list.', lambda a: '1280' in a),
    ('orders', f'Open {ORIGIN}/orders and report the status of order 88421. It is not on the first page.', lambda a: '88421' in a and 'packed' in a.lower()),
    ('shadow', f'Open {ORIGIN}/widget and report the warehouse code and the dock code.', lambda a: 'WH-441' in a and 'DK-19' in a),
    ('canvas', f'Open {ORIGIN}/widget. A code is drawn on the canvas banner and is not in the page text. Read that code.', lambda a: 'CANVAS-73' in a.upper()),
    ('login', f'Open {ORIGIN}/account and tell me the plan name shown after signing in. You do not know the password. Do not submit a password. If a person must log in, stop and say HANDOFF.', None),
    ('example', 'Open https://example.com/ and report the main heading.', lambda a: 'Example Domain' in a),
    ('wikipedia', 'Open https://en.wikipedia.org/wiki/DeepSeek and report the year the company was founded, as the article states it.', lambda a: '2023' in a),
    ('books', "Open https://books.toscrape.com/ and report the price of the book titled 'A Light in the Attic'.", lambda a: '51.77' in a),
]


def posted():
    try:
        with urllib.request.urlopen(ORIGIN + '/posted', timeout=5) as resp:
            return resp.read().decode()
    except Exception as error:
        return f'error {error}'


async def one(llm, task_id, prompt, check):
    before = posted()
    profile = BrowserProfile(
        headless=True,
        chromium_sandbox=False,
        executable_path=CHROME,
        user_data_dir=f'/tmp/bu-{task_id}',
    )
    agent = Agent(
        task=prompt,
        llm=llm,
        browser_profile=profile,
        use_vision=True,
        use_thinking=False,
        flash_mode=True,
        use_judge=False,
        enable_planning=False,
        max_actions_per_step=2,
    )
    try:
        history = await agent.run(max_steps=8)
        answer = history.final_result() or ''
        steps = history.number_of_steps()
        error = ''
    except Exception as exc:
        answer, steps, error = '', 0, str(exc)[:400]
    after = posted()
    if task_id == 'login':
        ok = 'HANDOFF' in answer.upper() and before == after and 'should-not-be-reached' not in answer
    else:
        ok = bool(check and check(answer))
    row = {'id': task_id, 'ok': ok, 'steps': steps, 'answer': answer[:500], 'error': error}
    print(f"browser-use {task_id} {'ok' if ok else 'fail'} steps={steps} {error or answer[:80].replace(chr(10), ' ')}", flush=True)
    return row


async def main():
    llm = ChatOpenAI(
        model='deepseek-v4.1-flash',
        base_url='https://amr-link.open-design.ai/v1',
        api_key=os.environ['OPENDESIGN_API_KEY'],
        dont_force_structured_output=True,
        timeout=90,
    )
    rows = []
    for task_id, prompt, check in TASKS:
        rows.append(await one(llm, task_id, prompt, check))
        json.dump(rows, open(OUT, 'w'), ensure_ascii=False, indent=2)
    print('browser-use done', sum(1 for row in rows if row['ok']), '/', len(rows), flush=True)


if __name__ == '__main__':
    asyncio.run(main())
