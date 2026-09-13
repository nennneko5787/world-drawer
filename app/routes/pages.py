"""ページルート (HTML配信)。"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import FileResponse

from app.objects.config import pagesDir

router = APIRouter()


@router.get("/")
async def index() -> FileResponse:
    return FileResponse(str(pagesDir / "index.html"))


@router.get("/help")
async def helpPage() -> FileResponse:
    return FileResponse(str(pagesDir / "help.html"))
