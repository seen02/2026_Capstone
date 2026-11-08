import math
import random
import unittest
import copy
from collections import defaultdict
from types import SimpleNamespace

from aquarium_sim.engine import Visitor, Simulation, clock_seconds
from aquarium_sim.movement import Movement, STEP, swept_distance2, front_distance
from tests.test_simulation import MAP, CONFIG


class MovementTests(unittest.TestCase):
    def world(self, people, width=10):
        nodes={"start":{"id":"start","x":2,"z":5,"kind":"junction"},
               "end":{"id":"end","x":8,"z":5,"kind":"door"}}
        sim=SimpleNamespace(now=0,entered=len(people),active={},graph=SimpleNamespace(nodes=nodes),
            map_data={"geometry":{"bounds":[0,0,12,width],"walkable_areas":[{"bounds":[0,0,12,width]}],
                                  "walls":[],"rooms":[],"human_radius_m":.23}},_push=lambda *args:None)
        sim._arrived=lambda a:setattr(a,"edge",None)
        movement=Movement(sim);sim.movement=movement
        for i,(point,goal) in enumerate(people,1):
            a=Visitor(i,0,0,1000,random.Random(i),node="start",position=point)
            if goal is not None:
                a.edge="path";a.next_node="end";a.move_goal=goal
            sim.active[i]=a
        return sim

    def run_steps(self,sim,count):
        for _ in range(count):
            previous={a.id:a.position for a in sim.active.values()}
            sim.now+=STEP;sim.movement.step()
            people=list(sim.active.values())
            for a in people:
                self.assertTrue(sim.movement.geometry.clear(previous[a.id],a.position))
                self.assertLessEqual(math.dist(previous[a.id],a.position),1.2*STEP+1e-8)
                for b in people:
                    if a.id>=b.id:continue
                    self.assertGreaterEqual(swept_distance2(previous[a.id],a.position,previous[b.id],b.position),.54**2-1e-8)

    def test_pass_stationary_person_without_overlap_or_teleport(self):
        sim=self.world([((2,5),(10,5)),((5,5),None)])
        self.run_steps(sim,200)
        a=sim.active[1]
        self.assertIsNone(a.edge)
        self.assertGreater(a.avoidance_steps,0)
        self.assertEqual(sim.active[2].position,(5,5))

    def test_head_on_and_crossing_traffic(self):
        for people in [
            [((2,5),(10,5)),((10,5),(2,5))],
            [((2,5),(10,5)),((6,1),(6,9))],
        ]:
            with self.subTest(people=people):
                sim=self.world(people);self.run_steps(sim,240)
                self.assertTrue(all(a.edge is None for a in sim.active.values()))

    def test_narrow_passage_waits_then_resumes(self):
        sim=self.world([((2,.5),(10,.5)),((5,.5),None)],width=1)
        self.run_steps(sim,60)
        a=sim.active[1]
        self.assertLess(a.position[0],5-.54)
        self.assertGreater(a.movement_wait_seconds,0)
        del sim.active[2]
        self.run_steps(sim,120)
        self.assertIsNone(a.edge)

    def test_wall_detour_and_crossing_between_frames(self):
        self.assertEqual(swept_distance2((0,0),(1,0),(1,0),(0,0)),0)
        sim=self.world([((2,5),(10,5))])
        sim.map_data["geometry"]["walls"]=[{"a":[6,2],"b":[6,8],"thickness":.2}]
        sim.movement=Movement(sim)
        self.run_steps(sim,320)
        self.assertIsNone(sim.active[1].edge)

    def test_departure_does_not_reserve_waiting_space(self):
        sim=Simulation(MAP,{**CONFIG,"daily_visitors":0})
        a=Visitor(1,0,sim.now,sim.closing,random.Random(1),node="D",next_node="queue_D",destination="exit",position=(63,35))
        sim.active[1]=a
        self.assertFalse(sim.movement.stopping(a))
        self.assertIsNotNone(sim.movement.goal(a))
        self.assertNotIn(a.id,sim.movement.claims)

    def test_concentrated_arrivals_and_gallery_transitions_keep_clearance(self):
        cfg=copy.deepcopy(CONFIG);cfg['daily_visitors']=120
        cfg['arrivals'].update(intensity='empirical_minutes',minute_weights=[1]+[0]*479,source='테스트 집중 입장')
        sim=Simulation(MAP,cfg)
        step=sim.movement.step
        checked=0
        def check_step():
            nonlocal checked
            before={id:a.position for id,a in sim.active.items()}
            step()
            buckets=defaultdict(list)
            for id,a in sim.active.items():
                p=before[id]
                self.assertTrue(sim.movement.geometry.clear(p,a.position))
                self.assertLessEqual(math.dist(p,a.position),1.2*STEP+1e-8)
                x,z=math.floor(p[0]/2),math.floor(p[1]/2)
                for i in range(x-1,x+2):
                    for j in range(z-1,z+2):
                        for other in buckets[i,j]:
                            self.assertGreaterEqual(swept_distance2(p,a.position,before[other.id],other.position),.54**2-1e-8)
                buckets[x,z].append(a)
            checked+=1
        sim.movement.step=check_step
        sim.advance_to(sim.now+600)
        self.assertEqual(sim.entered,120)
        self.assertGreater(checked,1000)
        self.assertTrue(any(a.avoidance_steps for a in sim.active.values()))
        self.assertTrue(any(a.movement_wait_seconds for a in sim.active.values()))

    def test_viewers_prefer_glass_without_rows_and_use_both_freshwater_tanks(self):
        sim=Simulation(MAP,{**CONFIG,'daily_visitors':0})
        for zone in 'ABCDEF':
            sim.active.clear();sim.movement.claims.clear()
            room=sim.movement.rooms[zone];points=[]
            for i in range(1,17):
                a=Visitor(i,0,sim.now,sim.closing,random.Random(i),node=room['queue_node'],next_node=zone,destination=zone)
                sim.active[i]=a
                p=sim.movement.goal(a);self.assertIsNotNone(p);points.append(p)
            self.assertLess(sum(front_distance(room,p) for p in points)/len(points),2.3)
            self.assertEqual(len({round(p[0],5) for p in points}),len(points))
            self.assertEqual(len({round(p[1],5) for p in points}),len(points))
            if zone=='E':
                self.assertTrue(any(p[0]<10 for p in points))
                self.assertTrue(any(p[0]>17 for p in points))

    def test_show_queue_follows_upper_lane_turn_and_lower_lane(self):
        sim=Simulation(MAP,{**CONFIG,'daily_visitors':0});show=sim.shows['F@10:20']
        sim.advance_to(show.queue_open)
        lobby=sim.graph.nodes['show_lobby']
        a=Visitor(1,0,sim.now,sim.closing,random.Random(1),node='show_lobby',position=(lobby['x'],lobby['z']))
        sim.active[1]=a;sim.entered=1;sim._target_show(a,show)
        points=[]
        for _ in range(800):
            old=a.position;sim.advance_to(sim.now+STEP);points.append(a.position)
            self.assertTrue(sim.movement.geometry.clear(old,a.position))
            if a.state=='queueing':break
        self.assertEqual(a.state,'queueing')
        self.assertTrue(any(x>59 and z<42 for x,z in points))
        self.assertTrue(any(x>59 and z>42.8 for x,z in points))
        self.assertLess(math.dist(a.position,(40,43.15)),.025)

    def test_abandoning_upper_queue_still_leaves_via_front(self):
        sim=Simulation(MAP,{**CONFIG,'daily_visitors':0});show=sim.shows['F@10:20']
        sim.advance_to(show.queue_open)
        a=Visitor(1,0,sim.now,sim.closing,random.Random(1),node='queue_F',destination='F',show_id=show.key,
                  queue_slot=49,position=(40,41.55))
        sim.active[1]=a;sim.entered=1;sim._join_show(a);sim._deadline(a)
        points=[]
        for _ in range(800):
            old=a.position;sim.advance_to(sim.now+STEP);points.append(a.position)
            self.assertTrue(sim.movement.geometry.clear(old,a.position))
            if a.node!='queue_F':break
        self.assertNotEqual(a.node,'queue_F')
        self.assertTrue(any(x>59 and z<42 for x,z in points))
        self.assertTrue(any(x>59 and z>42.8 for x,z in points))

    def test_two_visitors_can_merge_into_the_queue_without_deadlock(self):
        sim=Simulation(MAP,{**CONFIG,'daily_visitors':0});show=sim.shows['F@10:20']
        sim.advance_to(show.queue_open)
        for id,point in enumerate([(38.0583,41.6359),(38.0916,41.0960)],1):
            a=Visitor(id,0,sim.now,sim.closing,random.Random(id),node='show_lobby',position=point)
            sim.active[id]=a;sim._target_show(a,show)
        sim.entered=2
        for _ in range(800):
            old={id:a.position for id,a in sim.active.items()}
            sim.advance_to(sim.now+STEP)
            a,b=sim.active.values()
            self.assertGreaterEqual(swept_distance2(old[a.id],a.position,old[b.id],b.position),.54**2-1e-8)
            if all(a.state=='queueing' for a in sim.active.values()):break
        self.assertTrue(all(a.state=='queueing' for a in sim.active.values()))

    def test_crowd_merges_forward_and_full_show_redirects_overflow(self):
        sim=Simulation(MAP,{**CONFIG,'daily_visitors':0});show=sim.shows['F@10:20']
        sim.advance_to(show.queue_open)
        for i in range(60):
            a=Visitor(i+1,0,sim.now,sim.closing,random.Random(i+1),node='show_front',
                      position=(32+i%10*.8,35+i//10*.8))
            sim.active[a.id]=a;sim._target_show(a,show)
        sim.entered=60
        sim.advance_to(show.start+180)
        self.assertEqual(len(show.attended),50)
        self.assertGreater(len(show.full),0)
        self.assertFalse(any(a.show_id==show.key and a.edge for a in sim.active.values()))

    def test_show_queue_entrance_does_not_block_following_visitors(self):
        sim=Simulation(MAP,CONFIG)
        sim.advance_to(clock_seconds('10:22'))
        show=sim.shows['F@10:20']
        self.assertEqual(len(show.attended),show.capacity)
        self.assertFalse(any(a.show_id==show.key and a.edge for a in sim.active.values()))
        self.assertFalse(any(a.edge and a.next_node=='show_lobby' and sim.now-a.move_start>120 for a in sim.active.values()))


if __name__=="__main__":unittest.main()
