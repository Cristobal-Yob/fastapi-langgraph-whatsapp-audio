from typing import Literal, NotRequired, Protocol, TypedDict

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, Field

from app.prompts import ROUTER_PROMPT, RESPONSE_PROMPT

Route = Literal["preventa", "postventa", "generica"]


class RouteDecision(BaseModel):
    route: Route
    reason: str = Field(min_length=1, max_length=500)


class RoutingResult(RouteDecision):
    provider: Literal["google"]
    backend: Literal["vertex", "developer"]
    model_used: str = Field(min_length=1, max_length=160)
    fallback_used: bool


class GeneratedReply(BaseModel):
    response: str = Field(min_length=1, max_length=700)
    response_model_used: str = Field(min_length=1, max_length=160)
    response_fallback_used: bool


class Turn(TypedDict):
    user: str
    assistant: str


class AgentState(TypedDict):
    message: str
    history: NotRequired[list[Turn]]
    route: NotRequired[Route]
    reason: NotRequired[str]
    response: NotRequired[str]
    provider: NotRequired[str]
    backend: NotRequired[str]
    model_used: NotRequired[str]
    fallback_used: NotRequired[bool]
    response_delivery: NotRequired[str]
    audio_capable: NotRequired[bool]
    response_model_used: NotRequired[str]
    response_fallback_used: NotRequired[bool]


class StructuredRouter(Protocol):
    async def ainvoke(self, messages: list[BaseMessage]) -> RoutingResult: ...


def build_graph(router: StructuredRouter | None, responder=None):
    """Compile the stateless graph; None allows diagram inspection only."""

    async def route_message(state: AgentState):
        if router is None:
            raise RuntimeError("A configured router is required to invoke the graph.")
        messages: list[BaseMessage] = [SystemMessage(content=ROUTER_PROMPT)]
        for turn in state.get("history", []):
            messages.extend([HumanMessage(content=turn["user"]), AIMessage(content=turn["assistant"])])
        messages.append(HumanMessage(content=state["message"]))
        decision = await router.ainvoke(messages)
        return decision.model_dump()

    async def respond(state: AgentState):
        if responder is None:
            raise RuntimeError("A configured response provider is required.")
        delivery = state.get("response_delivery", "text")
        capable = state.get("audio_capable", False)
        messages = [SystemMessage(content=RESPONSE_PROMPT +
            f"\nEntrega actual de la respuesta: {delivery}\nCapacidad de audio: {capable}\nRuta: {state['route']}")]
        for turn in state.get("history", []):
            messages.extend([HumanMessage(content=turn["user"]), AIMessage(content=turn["assistant"])])
        messages.append(HumanMessage(content=state["message"]))
        return (await responder.ainvoke(messages)).model_dump()

    graph = StateGraph(AgentState)
    graph.add_node("route", route_message)
    graph.add_edge(START, "route")
    for route in ("preventa", "postventa", "generica"):
        graph.add_node(route, respond)
        graph.add_edge(route, END)
    graph.add_conditional_edges("route", lambda state: state["route"], {
        route: route for route in ("preventa", "postventa", "generica")
    })
    return graph.compile()
