"""共有の厳格モデル基底。"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)
