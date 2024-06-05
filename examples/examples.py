from typing import Dict
from whoachart import FlowChart

def simple_example():     
    fc = FlowChart()
    start = fc.start_symbol("Start") #start the flowchart
    
    #decisions need a condition_function
    have_an_egg = fc.decision(name='Do you have an egg?', condition_func=lambda context: True)
    start>have_an_egg  #link nodes together with the > operator
    
    cook_it = fc.symbol(name='Cook it')
    buy_one = fc.symbol(name='Buy one')
    #add options to the decision, along with the condition under which you visit that node
    have_an_egg.add_option(cook_it, condition=True)
    have_an_egg.add_option(buy_one, condition=False)
    
    end = fc.end_symbol(name='End')
    cook_it>end
    buy_one>end

    fc.render('simpleexample.png')
    fc.crawl(start=start)
    fc.render('simpleexample_crawled.png')
    
def bigger_example():
    def is_egg_raw(context:Dict):
        '''
        Check if the egg 
        is still raw
        '''
        return context['egg_state'] == 'raw'

    context = {'egg_state': 'raw', 'desired_state': 'boiled', 'water_temperature': 100}
    fc = FlowChart(context)
    start = fc.start_symbol("Start")
    egg_is_raw = fc.decision(name='Cooking egg?', condition_func=is_egg_raw) #docstring is used for the label
    boil_egg = fc.symbol("Boil egg")
    do_nothing = fc.symbol("Do nothing")
    start>egg_is_raw
    egg_is_raw.add_option(boil_egg, condition=True)
    egg_is_raw.add_option(do_nothing, condition=False)

    long_explanation = '''
    The water temperature is crucial. \n It should be 100 degrees Celsius for boiling an egg.
    Here are some steps:

    - 1. Fill a pot with water
    - 2. Heat the water until it boils
    - 3. Carefully put the egg in the boiling water
    '''

    is_water_boiling = fc.decision("Is water boiling?", 
                                label=long_explanation,
                                condition_func=lambda c: c['water_temperature'] == 100)
    continue_boiling = fc.symbol("Continue boiling")
    stop_boiling = fc.symbol("Stop boiling")
    start>is_water_boiling
    is_water_boiling.add_option(continue_boiling, condition=True)
    is_water_boiling.add_option(stop_boiling, condition=False)

    end_symbol = fc.end_symbol("End")
    continue_boiling>end_symbol
    stop_boiling>end_symbol
    boil_egg>end_symbol
    do_nothing>end_symbol

    fc.crawl(start=start)

    fc.render('example.png')    

if __name__ == '__main__':
    simple_example()
    bigger_example()
