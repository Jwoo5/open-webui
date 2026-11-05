"""Removal of guest accounts, with their chats and files, once they have been idle long enough."""

import asyncio
import logging
import time

from sqlalchemy import func, select

from open_webui.env import GUEST_ACCOUNT_EMAIL_DOMAIN, GUEST_ACCOUNT_RETENTION_HOURS
from open_webui.internal.db import get_async_db_context
from open_webui.models.auths import Auths
from open_webui.models.files import Files
from open_webui.models.users import User
from open_webui.retrieval.vector.async_client import ASYNC_VECTOR_DB_CLIENT
from open_webui.storage.provider import Storage

log = logging.getLogger(__name__)

# How often idle guest accounts are looked for.
GUEST_ACCOUNT_CHECK_INTERVAL_SECONDS = 3600


def guest_account_cleanup_enabled() -> bool:
    return bool(GUEST_ACCOUNT_EMAIL_DOMAIN) and GUEST_ACCOUNT_RETENTION_HOURS > 0


async def idle_guest_user_ids(domain: str, cutoff: int) -> list[str]:
    """Return the ids of users other than admins whose email is at *domain* and who were last active before *cutoff*."""
    async with get_async_db_context() as session:
        rows = await session.execute(
            select(User.id).where(
                func.lower(User.email).endswith(f'@{domain.lower()}', autoescape=True),
                User.role != 'admin',
                func.coalesce(User.last_active_at, User.created_at, 0) < cutoff,
            )
        )
        return list(rows.scalars().all())


async def remove_guest_account(user_id: str) -> None:
    """Delete the user's files, stored and indexed, then the account with its chats."""
    for file in await Files.get_files_by_user_id(user_id):
        if file.path:
            try:
                await asyncio.to_thread(Storage.delete_file, file.path)
            except Exception as e:
                log.warning('Deleting the stored file %s failed: %s', file.id, e)
        try:
            if await ASYNC_VECTOR_DB_CLIENT.has_collection(f'file-{file.id}'):
                await ASYNC_VECTOR_DB_CLIENT.delete_collection(f'file-{file.id}')
        except Exception as e:
            log.warning('Deleting the index of file %s failed: %s', file.id, e)
        await Files.delete_file_by_id(file.id)
    if not await Auths.delete_auth_by_id(user_id):
        raise RuntimeError(f'the account {user_id} could not be deleted')


async def remove_idle_guest_accounts(now: float | None = None) -> int:
    """Remove every guest account idle for the retention period and return how many went."""
    if not guest_account_cleanup_enabled():
        return 0
    cutoff = int((time.time() if now is None else now) - GUEST_ACCOUNT_RETENTION_HOURS * 3600)
    removed = 0
    for user_id in await idle_guest_user_ids(GUEST_ACCOUNT_EMAIL_DOMAIN, cutoff):
        try:
            await remove_guest_account(user_id)
        except Exception:
            log.exception('Removing the guest account %s failed', user_id)
        else:
            removed += 1
    return removed


async def periodic_guest_account_cleanup() -> None:
    while True:
        try:
            removed = await remove_idle_guest_accounts()
            if removed:
                log.info('Removed %d idle guest accounts', removed)
        except Exception:
            log.exception('Looking for idle guest accounts failed')
        await asyncio.sleep(GUEST_ACCOUNT_CHECK_INTERVAL_SECONDS)
