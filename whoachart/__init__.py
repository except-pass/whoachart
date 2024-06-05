import html
from typing import TypeVar, Union, Dict, Any, Optional
import networkx as nx
import pygraphviz as pgv
from networkx.drawing.nx_agraph import write_dot

from loguru import logger

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
    
SymbolType = TypeVar('SymbolType', bound='Symbol')
class Symbol:
    shape: str='box'
    label_format: str='<{name}<br/><font point-size="10">{label}</font>>'
    def __init__(self, name, label:str=None, graph:nx.Graph=None, **kwargs):
        self.name = name
        self._label = label
        self.label = self.format_label(label)
        self.graph = graph
        
        self.times_considered = 0
        self.__post_init__(**kwargs)
        
    def format_label(self, label_text:Optional[str]):
        if label_text is None:
            return self.name
        
        text = self.label_format.format(name=self.name, label=label_text)
        text = text.replace('\n', '<br/>')
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
        
    def set_edge_attributes(self, other: SymbolType, **attrs):
        nx.set_edge_attributes(self.graph, {(self.name, other.name): attrs})
        
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
    def __post_init__(self, condition_func:callable):
        self.options = {}
        self.condition_func = condition_func
        doc_string = condition_func.__doc__
        if self._label is None and doc_string is not None:            
            escaped_text = html.escape(doc_string.strip())
            self.label = self.format_label(escaped_text)
        
    def add_option(self, node:Symbol, condition:Any):
        self.options[condition] = node
        self.join_symbols(node)
        self.set_edge_attributes(node, label=condition)
    
    def check_condition(self, context:Dict):
        result = self.condition_func(context)
        next_node = self.options.get(result)
        return next_node
    
    def get_next_nodes(self, context:Dict):
        next_node = self.check_condition(context)
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

class ColorConfig:
    VISITED = 'blue'

class FlowChart:
    colors = ColorConfig()
    def __init__(self, context:Dict=None, graphtype=nx.DiGraph):
        self.graph = graphtype()
        self.context = {} if context is None else context
        
        self.max_recursion_steps = 100
        
        self.symbols = {}
    
    def add_symbol(self, symbol:Symbol):
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
    
    def render(self, filename:str):
        return render(self.graph, filename)
    
    def get_symbol(self, symbol:Union[str, Symbol]):
        if isinstance(symbol, Symbol):
            return symbol
        return self.symbols[symbol]
    
    def consider_node(self, node:Symbol):
        logger.debug(f"Current node: {node}")
        node._consider(self.context)
        next_nodes = node.get_next_nodes(self.context)
        return [self.get_symbol(n) for n in next_nodes]
    
    def crawl(self, start:Symbol):
        current_node = self.get_symbol(start)
        next_nodes = self.consider_node(current_node)
        if current_node.times_considered > self.max_recursion_steps:
            raise RecursionError(f"Max recursion steps reached for {current_node.name}")
        
        current_node.set_node_attributes(color=self.colors.VISITED)
        
        for node in next_nodes:
            current_node.set_edge_attributes(node, color=self.colors.VISITED)
            self.crawl(node)
