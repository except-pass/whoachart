import html
from typing import TypeVar, Union, Dict, Any, Optional
import networkx as nx
import pygraphviz as pgv
from networkx.drawing.nx_agraph import write_dot

from loguru import logger

"""
def render(graph:nx.Graph, filename:str):
    '''
    filename (str): The filename without extension.  Can be any legal extension like png or svg.
    '''
    # Write the dot file
    write_dot(graph, f'{filename}.dot')

    # Use pygraphviz to render the dot file
    A = pgv.AGraph(f'{filename}.dot')
    A.layout(prog='dot')
    A.draw(filename)
"""
def render(graph: nx.Graph, filename: str=None, format='png'):
    '''
    Render the graph to a file with the specified filename and extension.

    Args:
        graph (nx.Graph): The NetworkX graph to render.
        filename (str): The filename with extension. Can be any legal extension like png or svg.
    '''
    # Convert the graph to a DOT format string
    dot_str = nx.nx_pydot.to_pydot(graph).to_string()

    # Use pygraphviz to render the DOT string
    A = pgv.AGraph(string=dot_str)
    A.layout(prog='dot')
    return A.draw(filename, format=format)

VISITED = 'visited'

DEFAULT_FORMATS = {
    VISITED: {'color': 'blue'}
}


SymbolType = TypeVar('SymbolType', bound='Symbol')
class Symbol:
    shape: str='box'
    label_format: str='<{name}<br/><font point-size="10">{label}</font>>'
    colors: Dict=DEFAULT_FORMATS
    def __init__(self, name, label:str=None, graph:nx.Graph=None, **kwargs):
        self.name = name
        self._label = label
        self.label = self.format_text_as_label(label)
        self.graph = graph
        
        self.times_considered = 0
        self.__post_init__(**kwargs)
        
    def format_text_as_label(self, *args, **kwargs):
        text_entries = []
        for arg in args:
            if arg is not None:
                text_entries.append(html.escape(arg))
        for key, value in kwargs.items():
            text_entries.append(f"{key} {html.escape(value)}")

        if text_entries:
            label_text = '<br/>'.join(text_entries)
            text = self.label_format.format(name=self.name, label=label_text)
            text = text.replace('\n', '<br/>')
        else:
            text = self.name
            
        return text
        
    def __repr__(self):
        return f"<{self.__class__.__name__}({self.name})>"
    def __post_init__(self):
        pass
        
    def __gt__(self, other:Union[str, SymbolType]):
        return self.join_symbols(other)
        
    def join_symbols(self, other:SymbolType)->SymbolType:
        assert other.graph is None or other.graph is self.graph, "Symbols must be in the same graph"
        other.graph = self.graph
        self.graph.add_edge(self.name, other.name)
        return self

    def set_node_attributes(self, **attrs):
        nx.set_node_attributes(self.graph, {self.name: attrs})
        
    def format_node(self, action:str):
        kwargs = self.colors[action]
        self.set_node_attributes(**kwargs)

    def set_edge_attributes(self, other: SymbolType, **attrs):
        nx.set_edge_attributes(self.graph, {(self.name, other.name): attrs})

    def format_edge(self, other: SymbolType, action:str):
        kwargs = self.colors[action]
        self.set_edge_attributes(other, **kwargs)
        
    def set_label(self, text:str=None):
        text = text or self.label
        self.set_node_attributes(label=text)

    def _consider(self, context:Dict):
        logger.debug(f"Considering {self.name}")
        self.times_considered += 1
        return self.consider(context=context)

    def consider(self, context:Dict):
        #this can be overloaded by subclasses or custom symbols
        pass
    
    def get_next_nodes(self, context:Dict):
        return list(self.graph.successors(self.name))

class Decision(Symbol):
    shape = 'diamond'
    def __post_init__(self, condition_func:callable=None):
        self.options = {}
        self.condition_func = condition_func or self.condition
        doc_string = condition_func.__doc__
        self._label = self._label or doc_string
        self.label = self.format_text_as_label(self._label)

    def condition(self, context:Dict):
        raise NotImplementedError("You must implement a condition function or pass one in the constructor.")
    
    def add_option(self, node:Symbol, condition:Any):
        self.options[condition] = node
        self.join_symbols(node)
        self.set_edge_attributes(node, label=condition)
    
    def check_condition(self, context:Dict):
        result = self.condition_func(context)
        next_node = self.options.get(result)
        new_label=None
        return next_node, new_label
    
    def get_next_nodes(self, context:Dict):
        next_node, new_label = self.check_condition(context)
        self.set_label(new_label)
        return [next_node] if next_node is not None else []


class StartSymbol(Symbol):
    shape = 'ellipse'
    def __post_init__(self):
        pass
    
class EndSymbol(Symbol):
    shape = 'ellipse'
    def __post_init__(self):
        pass
    def get_next_nodes(self, context:Dict):
        return []
    

success_colors = DEFAULT_FORMATS.copy()
success_colors[VISITED] = {'color': 'green'}
class SuccessState(EndSymbol):
    colors=success_colors

failure_colors = DEFAULT_FORMATS.copy()
failure_colors[VISITED] = {'color': 'red'}
class FailState(EndSymbol):
    colors=failure_colors

warning_colors = DEFAULT_FORMATS.copy()
warning_colors[VISITED] = {'color': 'yellow'}
class WarningState(EndSymbol):
    colors=warning_colors

class FlowChart:
    def __init__(self, context:Dict=None, graphtype=nx.DiGraph):
        self.graph = graphtype()
        self.context = {} if context is None else context #don't need the context until we start crawling
        
        self.max_recursion_steps = 100
        
        self.symbols = {}
    
    def add_symbol(self, symbol:Symbol):
        assert symbol.name not in self.symbols, f"Symbol with name {symbol.name} already exists."
        self.symbols[symbol.name] = symbol
        self.graph.add_node(node_for_adding=symbol.name, shape=symbol.shape, label=symbol.label)
                
    def symbol(self, *args, **kwargs):
        s = Symbol(*args, **kwargs, graph=self.graph)
        self.add_symbol(s)
        return s
    def decision(self, *args, **kwargs):
        s = Decision(*args, **kwargs, graph=self.graph)
        self.add_symbol(s)        
        return s

    def start_symbol(self, *args, **kwargs):
        s = StartSymbol(*args, **kwargs, graph=self.graph)
        self.add_symbol(s)
        return s
    def end_symbol(self, *args, **kwargs):
        s = EndSymbol(*args, **kwargs, graph=self.graph)
        self.add_symbol(s)
        return s
    def success_state(self, *args, **kwargs):
        s = SuccessState(*args, **kwargs, graph=self.graph)
        self.add_symbol(s)
        return s
    def fail_state(self, *args, **kwargs):
        s = FailState(*args, **kwargs, graph=self.graph)
        self.add_symbol(s)
        return s
    def warning_state(self, *args, **kwargs):
        s = WarningState(*args, **kwargs, graph=self.graph)
        self.add_symbol(s)
        return s
    
    def render(self, filename:str=None, format:str="png"):
        return render(self.graph, filename, format=format)
    
    def get_symbol(self, symbol:Union[str, Symbol]):
        if isinstance(symbol, Symbol):
            return symbol
        return self.symbols[symbol]
    
    def find_start(self):
        starts = []
        for name, symbol in self.symbols.items():
            if isinstance(symbol, StartSymbol):
                starts.append(symbol)
        
        assert len(starts) == 1, f"Only one start symbol is allowed.  This graph has {len(starts)}"
        return starts[0]
    
    def consider_node(self, node:Symbol):
        logger.debug(f"Current node: {node}")
        node._consider(self.context)
        next_nodes = node.get_next_nodes(self.context)
        return [self.get_symbol(n) for n in next_nodes]
    
    def crawl(self, start:Symbol=None):
        start = start or self.find_start()
        current_node = self.get_symbol(start)
        next_nodes = self.consider_node(current_node)
        if current_node.times_considered > self.max_recursion_steps:
            raise RecursionError(f"Max recursion steps reached for {current_node.name}")
        
        #current_node.set_node_attributes(color=self.colors.VISITED)
        current_node.format_node(VISITED)
        
        for node in next_nodes:
            #current_node.set_edge_attributes(node, color=self.colors.VISITED)
            current_node.format_edge(node, VISITED)
            self.crawl(node)

    def result(self):
        results = []
        for _, symbol in self.symbols.items():
            if isinstance(symbol, EndSymbol) and symbol.times_considered > 0:
                results.append(symbol)
        return results
    
    def summary(self):
        start = self.find_start()
        results = self.result()
        return {'start': start, 'results': results}
