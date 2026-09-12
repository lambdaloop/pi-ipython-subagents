from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Literal

from comm import create_comm
from IPython import get_ipython

_HOST_TARGET = "pi-rlm-runtime.host"

ReceiverRole = Literal["parent", "sibling", "subagent"]
AgentStatus = Literal["running", "idle", "dormant"]


@dataclass(frozen=True, slots=True)
class Subagent:
    id: str
    name: str
    session_dir: str | None
    model: str
    status: AgentStatus


@dataclass(frozen=True, slots=True)
class RLMModel:
    provider: str
    id: str
    name: str
    selector: str


@dataclass(frozen=True, slots=True)
class Agent:
    name: str
    id: str
    depth: int


@dataclass(frozen=True, slots=True)
class RelatedAgent(Agent):
    relationship: ReceiverRole
    status: AgentStatus


@dataclass(frozen=True, slots=True)
class AgentList:
    current: Agent
    entries: tuple[RelatedAgent, ...]


def _install_control_handlers() -> None:
    kernel = get_ipython().kernel
    kernel.control_handlers.setdefault("comm_msg", kernel.comm_manager.comm_msg)
    kernel.control_handlers.setdefault("comm_close", kernel.comm_manager.comm_close)


async def _request(request_type: str, **payload: Any) -> Any:
    loop = asyncio.get_running_loop()
    future = loop.create_future()
    comm = create_comm(target_name=_HOST_TARGET, primary=False)

    def receive(message: dict[str, Any]) -> None:
        def finish() -> None:
            if future.done():
                return
            try:
                data = message["content"]["data"]
                if data["status"] == "ok":
                    future.set_result(data.get("result"))
                else:
                    future.set_exception(RuntimeError(data["error"]))
            except (KeyError, TypeError) as error:
                future.set_exception(error)

        loop.call_soon_threadsafe(finish)

    comm.on_msg(receive)
    try:
        comm.open(data={"type": request_type, **payload})
        return await future
    finally:
        comm.close()


def _text(value: object, name: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{name} must be a string")
    value = value.strip()
    if not value:
        raise ValueError(f"{name} must not be empty")
    return value


def _status(value: object) -> AgentStatus:
    if value == "running":
        return "running"
    if value == "idle":
        return "idle"
    if value == "dormant":
        return "dormant"
    raise TypeError('status must be "running", "idle", or "dormant"')


def _subagent(result: Any) -> Subagent:
    if not isinstance(result, dict):
        raise TypeError("sub-agent must be an object")
    session_dir = result.get("session_dir")
    if session_dir is not None and not isinstance(session_dir, str):
        raise TypeError("session_dir must be a string or None")
    return Subagent(
        id=_text(result.get("id"), "id"),
        name=_text(result.get("name"), "name"),
        session_dir=session_dir,
        model=_text(result.get("model"), "model"),
        status=_status(result.get("status")),
    )


def _model(result: Any) -> RLMModel:
    if not isinstance(result, dict):
        raise TypeError("model must be an object")
    return RLMModel(
        provider=_text(result.get("provider"), "provider"),
        id=_text(result.get("id"), "id"),
        name=_text(result.get("name"), "name"),
        selector=_text(result.get("selector"), "selector"),
    )


def _agent_list(result: Any) -> AgentList:
    if not isinstance(result, dict):
        raise TypeError("agent list must be an object")
    current = result.get("current")
    entries = result.get("entries")
    if not isinstance(current, dict) or not isinstance(entries, list):
        raise TypeError("agent list requires current and entries")
    current_depth = current.get("depth")
    if not isinstance(current_depth, int):
        raise TypeError("current.depth must be an int")

    related: list[RelatedAgent] = []
    for item in entries:
        if not isinstance(item, dict):
            raise TypeError("agent list entry must be an object")
        relationship = item.get("relationship")
        if relationship not in ("parent", "sibling", "subagent"):
            raise TypeError('relationship must be "parent", "sibling", or "subagent"')
        depth = item.get("depth")
        if not isinstance(depth, int):
            raise TypeError("depth must be an int")
        related.append(
            RelatedAgent(
                relationship=relationship,
                name=_text(item.get("name"), "name"),
                id=_text(item.get("id"), "id"),
                depth=depth,
                status=_status(item.get("status")),
            )
        )

    return AgentList(
        current=Agent(
            name=_text(current.get("name"), "current.name"),
            id=_text(current.get("id"), "current.id"),
            depth=current_depth,
        ),
        entries=tuple(related),
    )


class RLM:
    async def __call__(
        self,
        prompt: str,
        *,
        name: str | None = None,
        model: str | None = None,
    ) -> Subagent:
        return _subagent(
            await _request(
                "rlm.run",
                prompt=_text(prompt, "prompt"),
                name=_text(name, "name") if name is not None else None,
                model=_text(model, "model") if model is not None else None,
            )
        )

    async def find_models(self, query: str = "") -> list[RLMModel]:
        return [_model(model) for model in await _request("rlm.find_models", query=query)]

    async def list_subagents(self) -> list[Subagent]:
        return [_subagent(subagent) for subagent in await _request("rlm.list_subagents")]

    async def delete_subagent(self, subagent: str | Subagent) -> Subagent:
        target = subagent.id if isinstance(subagent, Subagent) else _text(subagent, "sub-agent")
        return _subagent(await _request("rlm.delete_subagent", target=target))


class AgentMessage:
    """Messages between parents, siblings, and direct sub-agents."""

    async def list_agents(self) -> AgentList:
        return _agent_list(await _request("agent_message.list_agents"))

    async def send(
        self,
        message: str,
        *,
        receiver_role: ReceiverRole,
        receiver_name: str | None = None,
    ) -> None:
        if receiver_role not in ("parent", "sibling", "subagent"):
            raise ValueError('receiver_role must be "parent", "sibling", or "subagent"')
        if receiver_role == "parent":
            if receiver_name is not None:
                raise ValueError("receiver_name must be omitted for parent messages")
        else:
            receiver_name = _text(receiver_name, "receiver_name")

        await _request(
            "agent_message.send",
            message=_text(message, "message"),
            receiver_role=receiver_role,
            receiver_name=receiver_name,
        )


_install_control_handlers()
rlm = RLM()
agent_message = AgentMessage()

__all__ = ["Agent", "AgentList", "RelatedAgent", "RLMModel", "Subagent", "agent_message", "rlm"]
